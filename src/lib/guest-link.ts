import { db } from "./db";
import { channexRequest } from "./channex";

/**
 * Sends a new guest their portal link on the OTA's own message thread.
 *
 * The wording and the rules come from the WhatsApp bot, which has been talking
 * to these guests for months: short, warm, no dashes, and above all **only ever
 * the guest portal link**. Never a payment provider link, never a door code,
 * never WiFi. Guests pay inside the portal, and everything about their stay
 * appears on that one URL once they have. Two systems telling a guest different
 * things is worse than one telling them nothing.
 */

export type LinkSendResult = {
  considered: number;
  sent: number;
  no_thread: number;
  failed: number;
  errors: string[];
};

type ThreadAttributes = { id?: string; booking_id?: string; ota_reservation_code?: string };

function firstName(full: string | null): string {
  const name = (full ?? "").trim().split(/\s+/)[0];
  return name && name.length > 1 ? name : "there";
}

/** Short, human, and the portal link is the only link in it. */
export function welcomeMessage(guestName: string | null, portalUrl: string): string {
  return [
    `Hi ${firstName(guestName)}, thanks for booking with Victory Suites.`,
    `Here is your guest portal link, everything for your stay lives on it: ${portalUrl}`,
    `Complete your payment and check in there, and your arrival details will appear on the same link.`,
    `Any questions, just reply here.`,
  ].join(" ");
}

async function threadFor(channexPropertyId: string, bookingId: string | null, otaRef: string | null): Promise<string | null> {
  const res = await channexRequest<{ data?: { id?: string; attributes?: ThreadAttributes }[] }>(
    "GET",
    `/message_threads?filter[property_id]=${channexPropertyId}`,
  );
  for (const row of res.body?.data ?? []) {
    const a = row.attributes ?? {};
    if (bookingId && a.booking_id === bookingId) return row.id ?? a.id ?? null;
    if (otaRef && a.ota_reservation_code === otaRef) return row.id ?? a.id ?? null;
  }
  return null;
}

export async function sendPendingGuestLinks(): Promise<LinkSendResult> {
  const supabase = db();
  const result: LinkSendResult = { considered: 0, sent: 0, no_thread: 0, failed: 0, errors: [] };

  const { data: waiting, error } = await supabase
    .from("inbound_bookings")
    .select("id, revision_id, channex_booking_id, ota_reservation_code, guest_name, portal_url, status, property_id")
    .is("link_sent_at", null)
    .not("portal_url", "is", null)
    .neq("status", "cancelled")
    .limit(25);
  if (error) throw new Error(`Reading bookings: ${error.message}`);

  for (const booking of waiting ?? []) {
    result.considered++;

    const { data: property } = await supabase
      .from("properties")
      .select("channex_property_id")
      .eq("id", booking.property_id as string)
      .maybeSingle();
    const channexPropertyId = property?.channex_property_id as string | undefined;
    if (!channexPropertyId) { result.failed++; continue; }

    const threadId = await threadFor(
      channexPropertyId,
      (booking.channex_booking_id as string) ?? null,
      (booking.ota_reservation_code as string) ?? null,
    );

    // No thread yet is normal: the OTA opens one when the guest first writes.
    // The booking waits here and is picked up on the next pass.
    if (!threadId) { result.no_thread++; continue; }

    const sent = await channexRequest(
      "POST",
      `/message_threads/${threadId}/messages`,
      { message: welcomeMessage(booking.guest_name as string | null, booking.portal_url as string) },
    );

    if (!sent.ok) {
      result.failed++;
      if (sent.error) result.errors.push(sent.error);
      continue;
    }

    await supabase.from("inbound_bookings").update({ link_sent_at: new Date().toISOString() }).eq("id", booking.id as string);
    result.sent++;
  }

  return result;
}
