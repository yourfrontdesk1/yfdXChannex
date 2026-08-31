import { db } from "./db";
import { channexRequest, compact } from "./channex";
import { addDays, today } from "./dates";
import type { AriRow, Property, RatePlan, RoomType } from "./types";

/**
 * Channex expect a full sync to be exactly two calls: 500 days of availability
 * for every room type, and 500 days of rates and restrictions for every rate
 * plan. Anything that loops per date or per rate plan fails the first test.
 */
export const FULL_SYNC_DAYS = 500;
const MIN_HOURS_BETWEEN_SYNCS = 24;

export type FullSyncReport = {
  property: string;
  days: number;
  availability: { values: number; task_id: string | null; ok: boolean; error: string | null } | null;
  restrictions: { values: number; task_id: string | null; ok: boolean; error: string | null } | null;
  skipped: string | null;
};

export async function fullSync(propertyId: string, opts: { force?: boolean } = {}): Promise<FullSyncReport> {
  const supabase = db();

  const { data: propertyRow } = await supabase.from("properties").select("*").eq("id", propertyId).single();
  const property = propertyRow as (Property & { last_full_sync_at: string | null }) | null;

  const report: FullSyncReport = {
    property: property?.name ?? propertyId,
    days: FULL_SYNC_DAYS,
    availability: null,
    restrictions: null,
    skipped: null,
  };

  if (!property) {
    report.skipped = "Property not found";
    return report;
  }
  if (!property.channex_property_id) {
    report.skipped = "Property is not mapped to Channex yet";
    return report;
  }

  if (!opts.force && property.last_full_sync_at) {
    const hours = (Date.now() - Date.parse(property.last_full_sync_at)) / 3_600_000;
    if (hours < MIN_HOURS_BETWEEN_SYNCS) {
      report.skipped = `Last full sync was ${hours.toFixed(1)} hours ago, the limit is one a day`;
      return report;
    }
  }

  const start = today();
  const end = addDays(start, FULL_SYNC_DAYS - 1);

  // PostgREST caps a select at 1000 rows unless you page through it. A property
  // with four rate plans over 500 days is three thousand rows, so an unpaged
  // read silently covered about 165 days and the ranges stopped at different
  // dates per rate plan. Channex read exactly that as an unaligned full sync.
  async function allAri(): Promise<AriRow[]> {
    const page = 1000;
    const out: AriRow[] = [];
    for (let from = 0; ; from += page) {
      const { data, error } = await supabase
        .from("ari")
        .select("*")
        .eq("property_id", propertyId)
        .gte("date", start)
        .lte("date", end)
        .order("date")
        .order("room_type_id")
        .range(from, from + page - 1);
      if (error) throw new Error(`ari: ${error.message}`);
      const rows = (data ?? []) as AriRow[];
      out.push(...rows);
      if (rows.length < page) return out;
    }
  }

  const [{ data: roomTypeRows }, ariRows] = await Promise.all([
    supabase.from("room_types").select("*").eq("property_id", propertyId).order("sort"),
    allAri(),
  ]);

  const roomTypes = (roomTypeRows ?? []) as RoomType[];
  const { data: ratePlanRows } = roomTypes.length
    ? await supabase.from("rate_plans").select("*").in("room_type_id", roomTypes.map((r) => r.id))
    : { data: [] as RatePlan[] };
  const ratePlans = (ratePlanRows ?? []) as RatePlan[];
  const ari = ariRows;

  const availabilityValues = buildFullAvailability(property, roomTypes, ari, start);
  const restrictionValues = buildFullRestrictions(property, ratePlans, ari, start);

  if (availabilityValues.length > 0) {
    const res = await channexRequest("POST", "/availability", { values: availabilityValues }, { propertyId });
    report.availability = {
      values: availabilityValues.length,
      task_id: res.taskIds[0] ?? null,
      ok: res.ok,
      error: res.error,
    };
  }

  if (restrictionValues.length > 0) {
    const res = await channexRequest("POST", "/restrictions", { values: restrictionValues }, { propertyId });
    report.restrictions = {
      values: restrictionValues.length,
      task_id: res.taskIds[0] ?? null,
      ok: res.ok,
      error: res.error,
    };
  }

  await supabase.from("properties").update({ last_full_sync_at: new Date().toISOString() }).eq("id", propertyId);

  // A full sync is the state of the world, so anything queued before it is
  // already carried by it and would only spend rate limit budget twice.
  await supabase
    .from("outbox")
    .update({ sent_at: new Date().toISOString(), last_error: "superseded by full sync" })
    .eq("property_id", propertyId)
    .is("sent_at", null);

  return report;
}

function buildFullAvailability(property: Property, roomTypes: RoomType[], ari: AriRow[], start: string) {
  const byKey = new Map(
    ari.filter((r) => r.rate_plan_id === null).map((r) => [[r.room_type_id, r.date].join("|"), r]),
  );

  const values: {
    property_id: string;
    room_type_id: string;
    date_from: string;
    date_to: string;
    availability: number;
  }[] = [];

  for (const roomType of roomTypes) {
    if (!roomType.channex_room_type_id) continue;
    let span: (typeof values)[number] | null = null;

    for (let i = 0; i < FULL_SYNC_DAYS; i++) {
      const date = addDays(start, i);
      const row = byKey.get([roomType.id, date].join("|"));
      // A date nobody has touched sells at the room type's full count.
      const availability = row?.availability ?? roomType.count_of_rooms;

      if (span && span.availability === availability) {
        span.date_to = date;
        continue;
      }
      span = {
        property_id: property.channex_property_id as string,
        room_type_id: roomType.channex_room_type_id,
        date_from: date,
        date_to: date,
        availability,
      };
      values.push(span);
    }
  }
  return values;
}

function buildFullRestrictions(property: Property, ratePlans: RatePlan[], ari: AriRow[], start: string) {
  const byKey = new Map(ari.filter((r) => r.rate_plan_id).map((r) => [[r.rate_plan_id, r.date].join("|"), r]));

  const values: Record<string, unknown>[] = [];

  for (const plan of ratePlans) {
    if (!plan.channex_rate_plan_id) continue;
    let span: { value: Record<string, unknown>; signature: string } | null = null;

    for (let i = 0; i < FULL_SYNC_DAYS; i++) {
      const date = addDays(start, i);
      const row = byKey.get([plan.id, date].join("|"));
      if (!row) {
        // Nothing at all for this date. Breaking the span here is what left the
        // last date_to differing between rate plans, which Channex read as an
        // unaligned full sync, so it is worth knowing that is the only case.
        span = null;
        continue;
      }

      // A full sync states the whole world, so every restriction the property
      // declares support for is sent explicitly. Leaving one out because it
      // happens to be null reads to Channex as "declared but never sent", which
      // is exactly what they rejected the first submission for.
      const payload: Record<string, unknown> = {
        min_stay_through: row.min_stay_through ?? 1,
        min_stay_arrival: row.min_stay_arrival ?? 1,
        max_stay: row.max_stay ?? 0,
        closed_to_arrival: row.closed_to_arrival ?? false,
        closed_to_departure: row.closed_to_departure ?? false,
        stop_sell: row.stop_sell ?? false,
      };
      // A rate plan with no price for a date still has restrictions worth
      // stating, and omitting only the rate keeps the date range unbroken.
      if (row.rate !== null && row.rate !== undefined) {
        payload.rate = Number(row.rate).toFixed(2);
      }

      const signature = JSON.stringify(payload);
      if (span && span.signature === signature) {
        span.value.date_to = date;
        continue;
      }
      const value: Record<string, unknown> = {
        property_id: property.channex_property_id as string,
        rate_plan_id: plan.channex_rate_plan_id,
        date_from: date,
        date_to: date,
        ...payload,
      };
      values.push(value);
      span = { value, signature };
    }
  }
  return values;
}
