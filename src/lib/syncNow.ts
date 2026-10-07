import { db } from "./db";
import { channexRequest } from "./channex";
import { fetchFeed, ingestRevision } from "./bookings";
import { syncAvailability } from "./parkside";
import { priceProperty } from "./pricing";
import { fullSync } from "./fullsync";
import { bookingComVerdict } from "./listings";

/**
 * What the Sync button does, all of it, in order, and proved at the end.
 *
 * Leon, 7 October 2026: "when I press sync they actually sync". The Full sync
 * button in YourFrontDesk had never worked (the proxy refused it), and a full
 * sync of unchanged values sends nothing on to Booking.com anyway. So this:
 *  1. pulls any booking Channex holds that has not reached us, in case a
 *     webhook was missed
 *  2. recounts availability from the guest portal
 *  3. reprices the next 30 nights
 *  4. sends all 500 days to Channex
 *  5. has Channex push its whole state to Booking.com
 *  6. reads Booking.com's own answer
 */
export type SyncStep = { step: string; ok: boolean; detail: string };

export async function syncNow(propertyId: string): Promise<{ ok: boolean; steps: SyncStep[] }> {
  const hub = db();
  const steps: SyncStep[] = [];
  const add = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail });
  const started = new Date().toISOString().slice(0, 19);

  const { data: property } = await hub.from("properties").select("name, channex_property_id, is_active").eq("id", propertyId).maybeSingle();
  if (!property?.channex_property_id) return { ok: false, steps: [{ step: "listing", ok: false, detail: "This listing is not on Channex" }] };

  try {
    const feed = await fetchFeed(property.channex_property_id as string);
    let added = 0;
    for (const r of feed) { const res = await ingestRevision(r); if (!res.error || res.forwarded) added++; }
    add("Bookings", true, feed.length ? `${added} booking change${added === 1 ? "" : "s"} pulled from Channex that had not arrived` : "No missed bookings, all already here");
  } catch (e) {
    add("Bookings", false, e instanceof Error ? e.message : String(e));
  }

  try {
    const a = await syncAvailability(propertyId);
    add("Availability", true, `${a.apartments} apartments, ${a.bookings_held} bookings held, ${a.rows_changed} nights changed`);
  } catch (e) {
    add("Availability", false, e instanceof Error ? e.message : String(e));
  }

  try {
    const p = await priceProperty(propertyId, "near");
    add("Prices", true, `${p.nights_considered} nights checked, ${p.prices_changed} changed, average £${p.average ?? "n/a"}`);
  } catch (e) {
    add("Prices", false, e instanceof Error ? e.message : String(e));
  }

  const full = await fullSync(propertyId, { force: true });
  const sentOk = !!(full.availability?.ok && full.restrictions?.ok);
  add("Sent to Channex", sentOk, sentOk
    ? `${full.days} days: ${full.availability?.values ?? 0} availability and ${full.restrictions?.values ?? 0} price values`
    : `${full.availability?.error ?? ""} ${full.restrictions?.error ?? ""}`.trim() || (full.skipped ?? "Not sent"));

  const { data: channel } = await hub
    .from("channels")
    .select("channex_channel_id, is_active")
    .eq("property_id", propertyId)
    .eq("channel", "BookingCom")
    .maybeSingle();
  if (!channel?.channex_channel_id || !channel.is_active) {
    add("Booking.com", false, "This listing's Booking.com channel is switched off, so nothing goes to Booking.com");
    return { ok: false, steps };
  }

  const pushed = await channexRequest("POST", `/channels/${channel.channex_channel_id}/full_sync`);
  if (!pushed.ok) {
    add("Booking.com", false, `Channex would not push to Booking.com: ${pushed.error}`);
    return { ok: false, steps };
  }
  const verdict = await bookingComVerdict(channel.channex_channel_id as string, started);
  add("Booking.com", verdict.ok, verdict.ok ? "Booking.com accepted availability and prices" : `Booking.com refused: ${verdict.reason}`);

  return { ok: steps.every((s) => s.ok), steps };
}
