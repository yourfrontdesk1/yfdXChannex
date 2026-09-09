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

/** Tuesday 8 September 2026, the way the message has always read. */
function longDate(date: string | null): string {
  if (!date) return "";
  // en-GB puts a comma after the weekday. The message Leon sends does not.
  return new Date(`${date}T00:00:00Z`)
    .toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .replace(",", "");
}

function money(amount: number | null, currency: string | null): string | null {
  if (amount === null || amount === undefined) return null;
  return `${currency ?? "GBP"} ${amount.toFixed(2)}`;
}

/**
 * The message Victory Suites already sends, word for word. It was written by
 * Leon and it works, so it is reproduced rather than improved on: the portal
 * link, the three things the guest has to do, the reassurance about payment,
 * their dates, their total, and a way to reach a person.
 */
export function welcomeMessage(booking: {
  guest_name: string | null;
  portal_url: string;
  arrival_date: string | null;
  departure_date: string | null;
  amount: number | null;
  currency: string | null;
}): string {
  const full = (booking.guest_name ?? "").trim() || "there";
  const total = money(booking.amount, booking.currency);

  const lines = [
    `Hi ${full},`,
    ``,
    `Thank you for booking with Victory Suites!`,
    ``,
    `To complete your check-in and payment, please use the secure guest portal link below.`,
    ``,
    booking.portal_url,
    ``,
    `You will need to:`,
    `1. Upload your passport or ID`,
    `2. Confirm your details`,
    `3. Complete payment on the final step`,
    ``,
    `Payment can be made at any time before your arrival. There is no rush.`,
    ``,
    `Check-in: ${longDate(booking.arrival_date)} 15:00`,
    `Check-out: ${longDate(booking.departure_date)}`,
  ];

  if (total) lines.push(``, `Total: ${total}`);

  lines.push(
    ``,
    `If you have any questions ${firstName(booking.guest_name)}, feel free to message us on WhatsApp at +350 56020139.`,
    ``,
    `We look forward to welcoming you ${full}!`,
    ``,
    `Best regards,`,
    `Victory Suites`,
  );

  return lines.join("\n");
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

  // Everything before the production cutover is certification data. It must
  // never be messaged, the same rule the forward retry follows.
  const { data: cutoverRow } = await supabase.from("hub_config").select("value").eq("key", "forward_cutover_at").maybeSingle();
  const cutover = (cutoverRow?.value as string) ?? new Date().toISOString();

  // One booking, not one revision. A stay that is booked and then amended
  // arrives as several revisions, and a guest who receives their link twice
  // learns that nobody is really watching.
  const { data: revisions, error } = await supabase
    .from("inbound_bookings")
    .select("id, revision_id, channex_booking_id, ota_reservation_code, guest_name, portal_url, status, property_id, arrival_date, departure_date, amount, currency, received_at, link_sent_at")
    .gte("received_at", cutover)
    .order("received_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Reading bookings: ${error.message}`);

  const latestOf = new Map<string, (typeof revisions)[number]>();
  const alreadySent = new Set<string>();
  const cancelled = new Set<string>();
  for (const row of revisions ?? []) {
    const key = (row.channex_booking_id as string) ?? (row.revision_id as string);
    if (row.link_sent_at) alreadySent.add(key);
    if (String(row.status).toLowerCase() === "cancelled") cancelled.add(key);
    // Only a revision that came back with a portal link can be sent, but every
    // revision counts when deciding whether the booking still stands.
    if (row.portal_url && !latestOf.has(key)) latestOf.set(key, row);
  }

  const waiting = [...latestOf.entries()]
    .filter(([key]) => !alreadySent.has(key) && !cancelled.has(key))
    .map(([, row]) => row)
    .slice(0, 25);

  for (const booking of waiting) {
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
      {
        message: welcomeMessage({
          guest_name: (booking.guest_name as string | null) ?? null,
          portal_url: booking.portal_url as string,
          arrival_date: (booking.arrival_date as string | null) ?? null,
          departure_date: (booking.departure_date as string | null) ?? null,
          amount: booking.amount === null || booking.amount === undefined ? null : Number(booking.amount),
          currency: (booking.currency as string | null) ?? null,
        }),
      },
    );

    if (!sent.ok) {
      result.failed++;
      if (sent.error) result.errors.push(sent.error);
      continue;
    }

    // Stamped on every revision of the booking, so a later amendment cannot
    // send the link a second time.
    await supabase
      .from("inbound_bookings")
      .update({ link_sent_at: new Date().toISOString() })
      .eq("channex_booking_id", booking.channex_booking_id as string);
    result.sent++;
  }

  return result;
}
