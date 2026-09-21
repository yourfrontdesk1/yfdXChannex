import { createClient } from "@supabase/supabase-js";
import { db } from "./db";

/**
 * Parkside's availability is not ours to invent. The twelve apartments are sold
 * on Booking.com, Hotelbeds, Expedia and direct, and the guest portal is where
 * all of that lands. This reads the portal and turns it into a count of free
 * units per room type per night, which is the only thing a channel manager
 * needs to know.
 *
 * Rates are untouched on purpose. Availability is a fact and can be derived; a
 * price is a decision.
 */

export const PARKSIDE_PROPERTY_ID = "3d9abd18-4ce4-4703-9cdd-7c879db8637f";
export const SYNC_DAYS = 500;

/**
 * Which apartments sell as which room type, declared by room number.
 *
 * This used to read the portal's own `type` column, which held while every room
 * type mapped onto exactly one portal type. It no longer does. 1.02 and 6.02
 * have no balcony and sell as their own Booking.com room, yet the portal records
 * them as `studio`, identical to 3.17A. Nothing in the portal can tell them
 * apart, so membership is declared here rather than derived, and the portal is
 * left untouched.
 */
export const ROOMS_BY_TYPE: Record<string, string[]> = {
  "Studio Apartment": ["3.17A", "4.17A", "8.17A"],
  "Standard Studio": ["1.02", "6.02"],
  "Executive Studio": ["1.11", "2.05", "7.08", "7.18", "9.17B"],
  "One Bedroom Apartment": ["1.14", "3.17B", "4.17B"],
  "Two Bedroom Apartment": ["2.17"],
};

export const PARKSIDE_ROOMS = Object.values(ROOMS_BY_TYPE).flat();

const TYPE_OF_ROOM: Record<string, string> = Object.fromEntries(
  Object.entries(ROOMS_BY_TYPE).flatMap(([type, rooms]) => rooms.map((room) => [room, type])),
);

export type AvailabilitySyncResult = {
  apartments: number;
  units: Record<string, number>;
  bookings_held: number;
  from: string;
  to: string;
  rows_changed: number;
  rows_already_correct: number;
  error: string | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

function portalClient() {
  const url = process.env.PORTAL_SUPABASE_URL;
  const key = process.env.PORTAL_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("PORTAL_SUPABASE_URL and PORTAL_SERVICE_ROLE_KEY are not set");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function syncParksideAvailability(): Promise<AvailabilitySyncResult> {
  const hub = db();
  const portal = portalClient();

  const today = new Date(iso(new Date()) + "T00:00:00Z");
  const dates = Array.from({ length: SYNC_DAYS }, (_, i) => iso(addDays(today, i)));
  const from = dates[0];
  const to = dates[dates.length - 1];

  const { data: apartments, error: aptError } = await portal
    .from("properties")
    .select("id, room_number, type")
    .in("room_number", PARKSIDE_ROOMS);
  if (aptError) throw new Error(`Portal apartments: ${aptError.message}`);

  // A missing apartment would silently overstate availability, so refuse rather
  // than publish a number we cannot stand behind.
  if (!apartments || apartments.length !== PARKSIDE_ROOMS.length) {
    throw new Error(`Expected ${PARKSIDE_ROOMS.length} Parkside apartments, the portal returned ${apartments?.length ?? 0}`);
  }

  const typeOfApartment = new Map(apartments.map((a) => [a.id as string, TYPE_OF_ROOM[a.room_number as string]]));
  const unitsOfType: Record<string, number> = {};
  for (const a of apartments) {
    const type = TYPE_OF_ROOM[a.room_number as string];
    unitsOfType[type] = (unitsOfType[type] ?? 0) + 1;
  }

  const { data: bookings, error: bookingError } = await portal
    .from("bookings")
    .select("property_id, check_in, check_out, status, is_active, no_show")
    .in("property_id", apartments.map((a) => a.id))
    .gte("check_out", from)
    .lte("check_in", to);
  if (bookingError) throw new Error(`Portal bookings: ${bookingError.message}`);

  const held = (bookings ?? []).filter(
    (b) => b.is_active && b.status !== "cancelled" && !b.no_show && b.check_in && b.check_out,
  );

  // A night is held from check in up to, but not including, check out.
  const soldOn = new Map<string, Record<string, number>>();
  for (const b of held) {
    const type = typeOfApartment.get(b.property_id as string);
    if (!type) continue;
    for (let d = new Date(`${b.check_in}T00:00:00Z`); iso(d) < b.check_out; d = addDays(d, 1)) {
      const key = iso(d);
      if (key < from || key > to) continue;
      if (!soldOn.has(key)) soldOn.set(key, {});
      const night = soldOn.get(key)!;
      night[type] = (night[type] ?? 0) + 1;
    }
  }

  const { data: roomTypes, error: rtError } = await hub
    .from("room_types")
    .select("id, name")
    .eq("property_id", PARKSIDE_PROPERTY_ID);
  if (rtError) throw new Error(`Hub room types: ${rtError.message}`);

  // PostgREST caps a select at 1000 rows. Four room types over 500 days is two
  // thousand, so an unpaged read silently reports half the grid as changed and
  // republishes values that were already right. This is the same fault that
  // failed certification the first time; it is paged deliberately.
  const existing = new Map<string, number | null>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error: ariError } = await hub
      .from("ari")
      .select("room_type_id, date, availability")
      .eq("property_id", PARKSIDE_PROPERTY_ID)
      .is("rate_plan_id", null)
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (ariError) throw new Error(`Hub ari: ${ariError.message}`);
    for (const r of page ?? []) existing.set(`${r.room_type_id}|${r.date}`, r.availability as number | null);
    if (!page || page.length < PAGE) break;
  }

  const rows: { property_id: string; room_type_id: string; rate_plan_id: null; date: string; availability: number }[] = [];
  let alreadyCorrect = 0;
  for (const rt of roomTypes ?? []) {
    // A room type with no apartments declared would publish zero for every
    // night, quietly shutting a room that is in fact for sale.
    if (!ROOMS_BY_TYPE[rt.name as string]) throw new Error(`No apartments are declared for room type "${rt.name}"`);
    const total = unitsOfType[rt.name as string] ?? 0;
    for (const date of dates) {
      const sold = soldOn.get(date)?.[rt.name as string] ?? 0;
      const availability = Math.max(0, total - sold);
      if (existing.get(`${rt.id}|${date}`) === availability) { alreadyCorrect++; continue; }
      rows.push({ property_id: PARKSIDE_PROPERTY_ID, room_type_id: rt.id as string, rate_plan_id: null, date, availability });
    }
  }

  // Only the changed nights are written, so the outbox trigger enqueues only
  // what actually moved and the worker sends the smallest possible call.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await hub.from("ari").upsert(rows.slice(i, i + 500), { onConflict: "room_type_id,rate_plan_id,date" });
    if (error) throw new Error(`Writing ari: ${error.message}`);
  }

  return {
    apartments: apartments.length,
    units: unitsOfType,
    bookings_held: held.length,
    from,
    to,
    rows_changed: rows.length,
    rows_already_correct: alreadyCorrect,
    error: null,
  };
}

/**
 * Picks the actual apartment a booking becomes, and rotates them.
 *
 * Channex sells a room type. The guest portal does NOT choose a flat: it only
 * resolves one if the caller names it, and its reply carries no room at all. So
 * if nobody picks, the booking reaches the portal, mints a link and messages the
 * guest, then attaches to no apartment anywhere. That is the quietest possible
 * failure and it sat in this path until it was caught.
 *
 * Which free flat gets it matters more than it first appears. Over the ninety
 * days to 21 September the executive studios ranged from 91 nights sold to 45,
 * and the one beds from 84 to 61. These apartments have different owners on
 * different splits, so an uneven hand out is uneven income as much as it is
 * uneven wear.
 *
 * So the order is a rotation: fewest nights sold in the recent window first, and
 * where two are level, whichever has been empty longest. Left alone it pulls the
 * quiet flats up towards the busy ones rather than holding a gap open.
 */
const ROTATION_WINDOW_DAYS = 90;

export async function pickFreeApartment(
  roomTypeName: string,
  checkIn: string,
  checkOut: string,
): Promise<{ room: string | null; considered: number; reason: string | null; order: string[] }> {
  const rooms = ROOMS_BY_TYPE[roomTypeName];
  if (!rooms) return { room: null, considered: 0, reason: `No apartments are declared for "${roomTypeName}"`, order: [] };

  const portal = portalClient();
  const { data: apartments, error: aptError } = await portal
    .from("properties")
    .select("id, room_number")
    .in("room_number", rooms);
  if (aptError) return { room: null, considered: 0, reason: `Portal apartments: ${aptError.message}`, order: [] };
  if (!apartments?.length) return { room: null, considered: 0, reason: "The portal returned none of these apartments", order: [] };

  const ids = apartments.map((a) => a.id as string);

  // A stay holds from check in up to, but not including, check out, so two
  // bookings may share a date: one leaving, one arriving.
  const { data: clashes, error: clashError } = await portal
    .from("bookings")
    .select("property_id, check_in, check_out, status, is_active, no_show")
    .in("property_id", ids)
    .lt("check_in", checkOut)
    .gt("check_out", checkIn);
  if (clashError) return { room: null, considered: 0, reason: `Portal bookings: ${clashError.message}`, order: [] };

  type HeldRow = { property_id: string; check_in: string; check_out: string; status: string; is_active: boolean; no_show: boolean };
  const held = (rows: unknown): HeldRow[] =>
    ((rows ?? []) as HeldRow[]).filter((b) => b.is_active && b.status !== "cancelled" && !b.no_show);

  const taken = new Set(held(clashes).map((b) => b.property_id));
  const free = apartments.filter((a) => !taken.has(a.id as string));
  if (free.length === 0) {
    // Availability said this type was sellable, so being full here means the two
    // disagree. Better to say so than to hand a guest a flat somebody is in.
    return {
      room: null,
      considered: apartments.length,
      reason: "Every apartment of this type is occupied for those dates",
      order: [],
    };
  }

  const windowStart = iso(addDays(new Date(`${iso(new Date())}T00:00:00Z`), -ROTATION_WINDOW_DAYS));
  const today = iso(new Date());
  const { data: history } = await portal
    .from("bookings")
    .select("property_id, check_in, check_out, status, is_active, no_show")
    .in("property_id", ids)
    .gte("check_out", windowStart)
    .lte("check_in", today);

  const nights = new Map<string, number>();
  const lastOut = new Map<string, string>();
  for (const b of held(history)) {
    const id = b.property_id;
    for (let d = new Date(`${b.check_in}T00:00:00Z`); iso(d) < (b.check_out as string); d = addDays(d, 1)) {
      const key = iso(d);
      if (key < windowStart || key > today) continue;
      nights.set(id, (nights.get(id) ?? 0) + 1);
    }
    const out = b.check_out;
    if (!lastOut.has(id) || out > (lastOut.get(id) as string)) lastOut.set(id, out);
  }

  free.sort((a, b) => {
    const ida = a.id as string, idb = b.id as string;
    const byNights = (nights.get(ida) ?? 0) - (nights.get(idb) ?? 0);
    if (byNights !== 0) return byNights;
    // Level on nights, so give it to whichever has been standing empty longest.
    return (lastOut.get(ida) ?? "").localeCompare(lastOut.get(idb) ?? "");
  });

  return {
    room: free[0].room_number as string,
    considered: apartments.length,
    reason: null,
    order: free.map((a) => `${a.room_number}:${nights.get(a.id as string) ?? 0}n`),
  };
}
