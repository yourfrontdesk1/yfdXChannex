import { db } from "./db";

/**
 * Keeps YourFrontDesk's Inbox and Replies page in step with the Booking.com
 * conversation, which otherwise lives only here and in Channex. Until 6 October
 * 2026 nothing did, so the first guests on the no balcony listing were messaged
 * and the Inbox showed no conversation at all.
 *
 * Never throws: a copy that failed must not stop a guest being answered.
 */
type Mirror =
  | { kind: "message"; sender: "guest" | "host"; content: string; sent_at?: string | null; message_id?: string | null }
  | { kind: "escalation"; guest_message: string | null; reason: string };

export async function mirrorToYourFrontDesk(
  ref: { channexBookingId?: string | null; otaReservationCode?: string | null },
  body: Mirror,
): Promise<void> {
  try {
    const supabase = db();
    let query = supabase.from("inbound_bookings").select("property_id, ota_reservation_code").order("received_at", { ascending: false }).limit(1);
    if (ref.channexBookingId) query = query.eq("channex_booking_id", ref.channexBookingId);
    else if (ref.otaReservationCode) query = query.eq("ota_reservation_code", ref.otaReservationCode.replace(/^[A-Z]{3}-/, ""));
    else return;
    const { data: booking } = await query.maybeSingle();
    if (!booking?.property_id || !booking.ota_reservation_code) return;

    const { data: property } = await supabase
      .from("properties")
      .select("downstream_url, downstream_secret")
      .eq("id", booking.property_id as string)
      .maybeSingle();
    const base = property?.downstream_url as string | null;
    const secret = property?.downstream_secret as string | null;
    if (!base || !secret) return;

    await fetch(base.replace(/channex-webhook\/?$/, "channex-conversation"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-channex-webhook-secret": secret },
      body: JSON.stringify({ ...body, external_ref: `BDC-${booking.ota_reservation_code}` }),
    });
  } catch {
    // Deliberately quiet; see above.
  }
}
