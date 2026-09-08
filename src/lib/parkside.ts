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

const PARKSIDE_ROOMS = ["3.17A", "4.17A", "8.17A", "1.11", "2.05", "7.08", "7.18", "9.17B", "1.14", "3.17B", "4.17B", "2.17"];

/** Our room type name, against the type the portal records on an apartment. */
const PORTAL_TYPE_OF: Record<string, string> = {
  "Studio Apartment": "studio",
  "Executive Studio": "executive_studio",
  "One Bedroom Apartment": "one_bed",
  "Two Bedroom Apartment": "two_bed",
};

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

  const typeOfApartment = new Map(apartments.map((a) => [a.id as string, a.type as string]));
  const unitsOfType: Record<string, number> = {};
  for (const a of apartments) unitsOfType[a.type as string] = (unitsOfType[a.type as string] ?? 0) + 1;

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
    for (let d = new Date(`${b.check_in}T00:00:00Z`); iso(d) < (b.check_out as string); d = addDays(d, 1)) {
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
    const portalType = PORTAL_TYPE_OF[rt.name as string];
    if (!portalType) throw new Error(`No portal type is mapped for room type "${rt.name}"`);
    const total = unitsOfType[portalType] ?? 0;
    for (const date of dates) {
      const sold = soldOn.get(date)?.[portalType] ?? 0;
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
