import { createClient } from "@supabase/supabase-js";
import { db } from "./db";
import { sendGuestMessage } from "./messages";
import { mirrorToYourFrontDesk } from "./mirror";

/**
 * Reminds a guest who has not finished their check in, every two days, until
 * they do. Leon asked for it on 6 October 2026.
 *
 * Who: a Booking.com guest on a Channex listing whose link went, who arrives in
 * the next 21 days, and whose guest portal booking is not yet paid or checked in.
 * Further out is left alone on purpose: a stay next summer was not to be chased.
 * When: two days after the link or the last reminder, never on arrival day itself.
 * The portal is the judge of finished, not anything stored here.
 */

const EVERY_DAYS = 2;
const WITHIN_DAYS = 21;
const DONE = new Set(["balance_paid", "checked_in"]);

export type ReminderResult = { considered: number; sent: number; done: number; not_due: number; failed: number; errors: string[] };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const longDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

export function reminderText(firstName: string, arrival: string, portalUrl: string): string {
  const name = firstName.trim() || "there";
  return [
    `Hi ${name},`,
    ``,
    `Just a friendly reminder to complete your check in before you arrive on ${longDay(arrival)}. It only takes a few minutes: upload your passport or ID, confirm your details and complete payment on your guest portal.`,
    ``,
    portalUrl,
    ``,
    `Once that is done, your door code and WiFi will appear on the same page from 3pm on your arrival day.`,
    ``,
    `If you have any questions, just reply here and we will help.`,
    ``,
    `Victory Suites`,
  ].join("\n");
}

export async function sendReminders(): Promise<ReminderResult> {
  const hub = db();
  const result: ReminderResult = { considered: 0, sent: 0, done: 0, not_due: 0, failed: 0, errors: [] };

  const url = process.env.PORTAL_SUPABASE_URL, key = process.env.PORTAL_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("PORTAL_SUPABASE_URL and PORTAL_SERVICE_ROLE_KEY are not set");
  const portal = createClient(url, key, { auth: { persistSession: false } });

  const today = iso(new Date());
  const until = iso(new Date(Date.now() + WITHIN_DAYS * 86400000));
  const { data: rows, error } = await hub
    .from("inbound_bookings")
    .select("id, channex_booking_id, ota_reservation_code, guest_name, arrival_date, status, link_sent_at, last_reminder_at, portal_url, received_at, payload")
    .eq("status", "new")
    .not("link_sent_at", "is", null)
    .gt("arrival_date", today)
    .lte("arrival_date", until);
  if (error) throw new Error(`Bookings: ${error.message}`);

  const { data: cancelled } = await hub.from("inbound_bookings").select("ota_reservation_code").eq("status", "cancelled");
  const gone = new Set((cancelled ?? []).map((c) => c.ota_reservation_code));

  for (const b of rows ?? []) {
    if (gone.has(b.ota_reservation_code)) continue;
    result.considered++;

    const last = Date.parse((b.last_reminder_at as string) ?? (b.link_sent_at as string));
    if (Date.now() - last < EVERY_DAYS * 86400000 - 3600000) { result.not_due++; continue; }

    const ref = `BDC-${b.ota_reservation_code}`;
    const { data: pb } = await portal
      .from("bookings")
      .select("id, status, portal_step, token, portal_link_reminders")
      .eq("external_ref", ref)
      .maybeSingle();
    if (!pb || pb.status === "cancelled") { result.done++; continue; }
    if (DONE.has(pb.status as string) || pb.portal_step === "door-code") { result.done++; continue; }

    const portalUrl = (b.portal_url as string) || `https://guestportal.victorysuites.gi/guest/${pb.token}`;
    const first = (((b.payload as { customer?: { name?: string } })?.customer?.name) ?? String(b.guest_name ?? "").split(" ")[0] ?? "").trim();
    const text = reminderText(first, b.arrival_date as string, portalUrl);

    const sent = await sendGuestMessage({ bookingId: b.channex_booking_id as string, text });
    if (!sent.ok) { result.failed++; if (sent.error) result.errors.push(`${ref}: ${sent.error}`); continue; }

    const now = new Date().toISOString();
    await hub.from("inbound_bookings").update({ last_reminder_at: now }).eq("ota_reservation_code", b.ota_reservation_code as string);
    await portal.from("bookings").update({ portal_link_reminders: Number(pb.portal_link_reminders ?? 0) + 1 }).eq("id", pb.id as string);
    await mirrorToYourFrontDesk({ channexBookingId: b.channex_booking_id as string }, { kind: "message", sender: "host", content: text });
    result.sent++;
  }
  return result;
}
