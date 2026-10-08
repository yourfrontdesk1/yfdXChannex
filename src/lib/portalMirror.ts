import { createClient } from "@supabase/supabase-js";
import { db } from "./db";
import { roomsByProperty } from "./parkside";

/**
 * Files in YourFrontDesk every guest portal booking on a flat the hub sells,
 * whatever road it came by, so Check ins and the Calendar show every guest.
 * Leon, 8 October 2026: "all reservations are not in the system". Display only:
 * YourFrontDesk sends nothing for these and emails nobody.
 *
 * A Little Hotelier "Direct" copy of a stay that already sits in the portal
 * under a channel reference is skipped, so nobody appears twice.
 */
export async function mirrorPortalBookings(): Promise<{ considered: number; inserted: number; existed: number; duplicates: number; errors: string[] }> {
  const out = { considered: 0, inserted: 0, existed: 0, duplicates: 0, errors: [] as string[] };
  const url = process.env.PORTAL_SUPABASE_URL, key = process.env.PORTAL_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("PORTAL_SUPABASE_URL and PORTAL_SERVICE_ROLE_KEY are not set");
  const portal = createClient(url, key, { auth: { persistSession: false } });

  const rooms = Object.values(await roomsByProperty()).flatMap((t) => Object.values(t).flat());
  if (!rooms.length) return out;
  const { data: flats } = await portal.from("properties").select("id, room_number").in("room_number", rooms);
  const roomOf = new Map((flats ?? []).map((f) => [f.id as string, f.room_number as string]));

  const today = new Date().toISOString().slice(0, 10);
  const { data: bookings, error } = await portal
    .from("bookings")
    .select("id, external_ref, property_id, check_in, check_out, status, is_active, channel, booking_source, token, payment_link, portal_link_sent_at, balance_amount, deposit_amount, currency, num_guests, guest:guests(first_name, last_name, email, phone)")
    .in("property_id", [...roomOf.keys()])
    .gte("check_out", today);
  if (error) throw new Error(`Portal bookings: ${error.message}`);

  const live = (bookings ?? []).filter((b) => b.is_active && b.status !== "cancelled");
  const channelStay = new Set(
    live.filter((b) => !/^LH/i.test(String(b.external_ref ?? ""))).map((b) => `${b.property_id}|${b.check_in}|${b.check_out}`),
  );

  const { data: target } = await db()
    .from("properties")
    .select("downstream_url, downstream_secret")
    .not("downstream_url", "is", null)
    .limit(1)
    .maybeSingle();
  if (!target?.downstream_url || !target.downstream_secret) throw new Error("No YourFrontDesk endpoint configured");
  const endpoint = (target.downstream_url as string).replace(/channex-webhook\/?$/, "channex-conversation");

  const batch = [];
  for (const b of bookings ?? []) {
    if (!b.external_ref) continue;
    out.considered++;
    const stay = `${b.property_id}|${b.check_in}|${b.check_out}`;
    if (/^LH/i.test(String(b.external_ref)) && channelStay.has(stay)) { out.duplicates++; continue; }
    const g = (b.guest ?? {}) as { first_name?: string; last_name?: string; email?: string; phone?: string };
    const isLive = b.is_active && b.status !== "cancelled";
    batch.push({
      external_ref: b.external_ref,
      room: roomOf.get(b.property_id as string),
      check_in: b.check_in,
      check_out: b.check_out,
      status: isLive ? "active" : "cancelled",
      first_name: g.first_name ?? null,
      last_name: g.last_name ?? null,
      email: g.email ?? null,
      phone: g.phone ?? null,
      guests: b.num_guests ?? null,
      amount: Number(b.balance_amount ?? 0) + Number(b.deposit_amount ?? 0) || null,
      currency: b.currency ?? "GBP",
      source: b.channel ?? b.booking_source ?? null,
      portal_url: b.token ? `https://guestportal.victorysuites.gi/guest/${b.token}` : null,
      payment_link: b.payment_link ?? null,
      link_sent_at: b.portal_link_sent_at ?? null,
      portal_booking_id: b.id,
    });
  }
  // One call for the lot: a call per booking ran past the time limit.
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-channex-webhook-secret": target.downstream_secret as string },
    body: JSON.stringify({ kind: "bookings", external_ref: "batch", bookings: batch }),
  });
  const body = (await res.json().catch(() => ({}))) as { inserted?: number; existed?: number; error?: string };
  if (!res.ok) out.errors.push(body.error ?? `YourFrontDesk ${res.status}`);
  out.inserted = body.inserted ?? 0;
  out.existed = body.existed ?? 0;
  return out;
}
