import { db } from "./db";
import { addDays } from "./dates";
import type { AriRow, Property, RoomType } from "./types";

/**
 * A booking's hold on availability, keyed by our room type id and date, one
 * entry per room night. Inbound bookings from a channel and bookings made in
 * the PMS both express themselves this way, so a modification of either kind
 * is the same operation: release the previous effect, take the next one.
 */
export type Effect = Record<string, number>;

export function holdKey(roomTypeId: string, date: string): string {
  return [roomTypeId, date].join("|");
}

/** Nights from check-in up to, not including, check-out. */
export function nightsEffect(roomTypeId: string, checkin: string, checkout: string, rooms = 1): Effect {
  const effect: Effect = {};
  for (let date = checkin; date < checkout; date = addDays(date, 1)) {
    effect[holdKey(roomTypeId, date)] = (effect[holdKey(roomTypeId, date)] ?? 0) + rooms;
  }
  return effect;
}

/**
 * Availability is recalculated as an absolute number, never nudged by a delta.
 * Channex decrement their own copy on confirmation and that setting cannot be
 * turned off, so an absolute push is the only thing that stays correct whichever
 * side moved first.
 *
 * Only the dates whose net hold actually changed are written, so the trigger
 * enqueues exactly those and the channel manager receives an update for the
 * affected dates alone: moving a booking touches the dates it left and the
 * dates it now occupies, nothing in between.
 */
export async function applyEffectChange(
  property: Property,
  priorEffect: Effect,
  nextEffect: Effect,
): Promise<{ touched: number; dates: string[] }> {
  const supabase = db();

  const net: Effect = {};
  for (const [key, held] of Object.entries(priorEffect)) net[key] = (net[key] ?? 0) + held;
  for (const [key, held] of Object.entries(nextEffect)) net[key] = (net[key] ?? 0) - held;

  const touched = Object.entries(net).filter(([, delta]) => delta !== 0);
  if (touched.length === 0) return { touched: 0, dates: [] };

  const { data: roomTypeRows } = await supabase.from("room_types").select("*").eq("property_id", property.id);
  const roomTypes = (roomTypeRows ?? []) as RoomType[];

  const dates = [...new Set(touched.map(([key]) => key.split("|")[1]))].sort();
  const { data: current } = await supabase
    .from("ari")
    .select("*")
    .eq("property_id", property.id)
    .is("rate_plan_id", null)
    .gte("date", dates[0])
    .lte("date", dates[dates.length - 1]);

  const currentByKey = new Map(((current ?? []) as AriRow[]).map((r) => [holdKey(r.room_type_id, r.date), r]));

  const rows = touched.map(([key, delta]) => {
    const [roomTypeId, date] = key.split("|");
    const existing = currentByKey.get(key);
    const roomType = roomTypes.find((r) => r.id === roomTypeId);
    // A date nobody has touched sells at the room type's full count.
    const base = existing?.availability ?? roomType?.count_of_rooms ?? 0;
    const ceiling = roomType?.count_of_rooms ?? base;
    return {
      property_id: property.id,
      room_type_id: roomTypeId,
      rate_plan_id: null,
      date,
      availability: Math.max(0, Math.min(ceiling, base + delta)),
    };
  });

  const { error } = await supabase.from("ari").upsert(rows, { onConflict: "room_type_id,rate_plan_id,date" });
  if (error) throw new Error(`ari: ${error.message}`);

  return { touched: touched.length, dates };
}
