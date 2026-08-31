import { db } from "./db";
import { channexRequest, compact, remainingAriBudget } from "./channex";
import { addDays } from "./dates";
import type { AriRow, Property, RatePlan, RoomType } from "./types";

export type FlushReport = {
  property_id: string;
  property: string;
  claimed: number;
  sent: number;
  skipped: number;
  calls: { path: string; values: number; task_id: string | null; ok: boolean; error: string | null }[];
  note: string | null;
};

type OutboxRow = {
  id: number;
  property_id: string;
  kind: "availability" | "rate" | "restriction";
  room_type_id: string | null;
  rate_plan_id: string | null;
  date: string;
  /** Which fields actually changed. Written by the ari_enqueue trigger. */
  fields: string[] | null;
};

/** Every restriction field that travels on a rate plan, in the order Channex name them. */
const RESTRICTION_FIELDS = [
  "rate",
  "min_stay_through",
  "min_stay_arrival",
  "max_stay",
  "closed_to_arrival",
  "closed_to_departure",
  "stop_sell",
] as const;

export async function flushAll(limitPerProperty = 5000): Promise<FlushReport[]> {
  const supabase = db();
  const { data, error } = await supabase.rpc("properties_with_pending");
  if (error) throw new Error(error.message);

  const reports: FlushReport[] = [];
  for (const row of (data ?? []) as { property_id: string; pending: number }[]) {
    reports.push(await flushProperty(row.property_id, limitPerProperty));
  }
  return reports;
}

export async function flushProperty(propertyId: string, limit = 5000): Promise<FlushReport> {
  const supabase = db();

  const { data: property } = await supabase.from("properties").select("*").eq("id", propertyId).single();
  const prop = property as Property | null;

  const report: FlushReport = {
    property_id: propertyId,
    property: prop?.name ?? propertyId,
    claimed: 0,
    sent: 0,
    skipped: 0,
    calls: [],
    note: null,
  };

  if (!prop) {
    report.note = "Property not found";
    return report;
  }
  if (!prop.channex_property_id) {
    report.note = "Property is not mapped to Channex yet, nothing was sent";
    return report;
  }

  // The budget is checked before anything is claimed. A claimed row that cannot
  // be sent would sit locked for five minutes for no reason.
  const [availBudget, restrictBudget] = await Promise.all([
    remainingAriBudget(propertyId, "/availability"),
    remainingAriBudget(propertyId, "/restrictions"),
  ]);
  if (availBudget === 0 && restrictBudget === 0) {
    report.note = "Rate limit budget spent for this minute, deltas stay queued";
    return report;
  }

  const { data: claimed, error: claimError } = await supabase.rpc("claim_outbox", {
    p_property: propertyId,
    p_limit: limit,
  });
  if (claimError) throw new Error(claimError.message);

  const rows = (claimed ?? []) as OutboxRow[];
  report.claimed = rows.length;
  if (rows.length === 0) return report;

  const [roomTypes, ratePlans, ari] = await Promise.all([
    loadRoomTypes(propertyId),
    loadRatePlans(propertyId),
    loadAri(propertyId, rows),
  ]);

  const sentIds: number[] = [];
  const failed: { ids: number[]; error: string }[] = [];
  const deferred: number[] = [];

  // Availability, one call, every room type and date span inside it.
  const availRows = rows.filter((r) => r.kind === "availability");
  if (availRows.length > 0) {
    if (availBudget === 0) {
      deferred.push(...availRows.map((r) => r.id));
    } else {
      const { values, unmapped } = buildAvailabilityValues(prop, availRows, roomTypes, ari);
      deferred.push(...unmapped);
      if (values.length > 0) {
        const result = await channexRequest("POST", "/availability", { values }, { propertyId });
        report.calls.push({
          path: "/availability",
          values: values.length,
          task_id: result.taskIds[0] ?? null,
          ok: result.ok,
          error: result.error,
        });
        const ids = availRows.filter((r) => !unmapped.includes(r.id)).map((r) => r.id);
        if (result.ok) {
          sentIds.push(...ids);
          await stampTask(ids, result.taskIds[0] ?? null);
        } else {
          failed.push({ ids, error: result.error ?? "unknown" });
        }
      }
    }
  }

  // Rates and restrictions, one call, however many rate plans and spans it takes.
  const restrictionRows = rows.filter((r) => r.kind !== "availability");
  if (restrictionRows.length > 0) {
    if (restrictBudget === 0) {
      deferred.push(...restrictionRows.map((r) => r.id));
    } else {
      const { values, unmapped } = buildRestrictionValues(prop, restrictionRows, ratePlans, ari);
      deferred.push(...unmapped);
      if (values.length > 0) {
        const result = await channexRequest("POST", "/restrictions", { values }, { propertyId });
        report.calls.push({
          path: "/restrictions",
          values: values.length,
          task_id: result.taskIds[0] ?? null,
          ok: result.ok,
          error: result.error,
        });
        const ids = restrictionRows.filter((r) => !unmapped.includes(r.id)).map((r) => r.id);
        if (result.ok) {
          sentIds.push(...ids);
          await stampTask(ids, result.taskIds[0] ?? null);
        } else {
          failed.push({ ids, error: result.error ?? "unknown" });
        }
      }
    }
  }

  if (sentIds.length > 0) {
    await supabase.from("outbox").update({ sent_at: new Date().toISOString(), last_error: null }).in("id", sentIds);
  }
  for (const group of failed) {
    if (group.ids.length === 0) continue;
    await supabase.from("outbox").update({ claimed_at: null, last_error: group.error }).in("id", group.ids);
  }
  if (deferred.length > 0) {
    await supabase.from("outbox").update({ claimed_at: null }).in("id", deferred);
  }

  report.sent = sentIds.length;
  report.skipped = deferred.length;
  return report;
}

async function stampTask(ids: number[], taskId: string | null) {
  if (!taskId || ids.length === 0) return;
  await db().from("outbox").update({ channex_task_id: taskId }).in("id", ids);
}

async function loadRoomTypes(propertyId: string): Promise<Map<string, RoomType>> {
  const { data } = await db().from("room_types").select("*").eq("property_id", propertyId);
  return new Map(((data ?? []) as RoomType[]).map((r) => [r.id, r]));
}

async function loadRatePlans(propertyId: string): Promise<Map<string, RatePlan>> {
  const { data: roomTypes } = await db().from("room_types").select("id").eq("property_id", propertyId);
  const ids = (roomTypes ?? []).map((r) => r.id as string);
  if (ids.length === 0) return new Map();
  const { data } = await db().from("rate_plans").select("*").in("room_type_id", ids);
  return new Map(((data ?? []) as RatePlan[]).map((r) => [r.id, r]));
}

async function loadAri(propertyId: string, rows: OutboxRow[]): Promise<Map<string, AriRow>> {
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const { data } = await db()
    .from("ari")
    .select("*")
    .eq("property_id", propertyId)
    .gte("date", dates[0])
    .lte("date", dates[dates.length - 1]);

  const map = new Map<string, AriRow>();
  for (const row of (data ?? []) as AriRow[]) {
    map.set([row.room_type_id, row.rate_plan_id ?? "-", row.date].join("|"), row);
  }
  return map;
}

type AvailabilityValue = {
  property_id: string;
  room_type_id: string;
  date_from: string;
  date_to: string;
  availability: number;
};

export function buildAvailabilityValues(
  property: Property,
  rows: OutboxRow[],
  roomTypes: Map<string, RoomType>,
  ari: Map<string, AriRow>,
): { values: AvailabilityValue[]; unmapped: number[] } {
  const unmapped: number[] = [];
  const byRoomType = new Map<string, { date: string; availability: number }[]>();

  for (const row of rows) {
    const roomType = row.room_type_id ? roomTypes.get(row.room_type_id) : undefined;
    if (!roomType?.channex_room_type_id) {
      unmapped.push(row.id);
      continue;
    }
    const cell = ari.get([row.room_type_id, "-", row.date].join("|"));
    if (!cell || cell.availability === null || cell.availability === undefined) {
      unmapped.push(row.id);
      continue;
    }
    const list = byRoomType.get(roomType.channex_room_type_id) ?? [];
    list.push({ date: row.date, availability: cell.availability });
    byRoomType.set(roomType.channex_room_type_id, list);
  }

  const values: AvailabilityValue[] = [];
  for (const [channexRoomTypeId, entries] of byRoomType) {
    entries.sort((a, b) => a.date.localeCompare(b.date));
    let span: AvailabilityValue | null = null;
    for (const entry of entries) {
      if (span && span.availability === entry.availability && addDays(span.date_to, 1) === entry.date) {
        span.date_to = entry.date;
        continue;
      }
      span = {
        property_id: property.channex_property_id as string,
        room_type_id: channexRoomTypeId,
        date_from: entry.date,
        date_to: entry.date,
        availability: entry.availability,
      };
      values.push(span);
    }
  }
  return { values, unmapped };
}

type RestrictionValue = Record<string, unknown>;

export function buildRestrictionValues(
  property: Property,
  rows: OutboxRow[],
  ratePlans: Map<string, RatePlan>,
  ari: Map<string, AriRow>,
): { values: RestrictionValue[]; unmapped: number[] } {
  const unmapped: number[] = [];
  const byPlan = new Map<string, { date: string; payload: RestrictionValue; signature: string }[]>();

  const seen = new Set<string>();
  for (const row of rows) {
    const plan = row.rate_plan_id ? ratePlans.get(row.rate_plan_id) : undefined;
    if (!plan?.channex_rate_plan_id) {
      unmapped.push(row.id);
      continue;
    }
    // A rate change and a restriction change on the same cell are two outbox
    // rows and one value object, so the cell is only read once.
    const dedupe = [plan.channex_rate_plan_id, row.date].join("|");
    const cell = ari.get([row.room_type_id, row.rate_plan_id ?? "-", row.date].join("|"));
    if (!cell) {
      unmapped.push(row.id);
      continue;
    }
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    // Only the fields that actually changed. Sending the whole cell is what
    // Channex rejected: a rate change arrived carrying min stay, stop sell and
    // closed to arrival, and the unrelated fields differing day to day also
    // stopped consecutive dates merging into a date range.
    //
    // Rows for the same cell are collected first, because one save can change a
    // rate and a restriction together and that is still one value object.
    const changed = new Set<string>();
    for (const other of rows) {
      if (other.rate_plan_id !== row.rate_plan_id || other.date !== row.date) continue;
      for (const f of other.fields ?? []) changed.add(f);
    }
    // Nothing recorded means a delta from before the trigger tracked fields.
    // Falling back to everything set on the cell keeps those drainable.
    const wanted = changed.size > 0 ? changed : new Set(RESTRICTION_FIELDS as readonly string[]);

    const source: Record<string, unknown> = {
      rate: cell.rate === null || cell.rate === undefined ? null : Number(cell.rate).toFixed(2),
      min_stay_through: cell.min_stay_through,
      min_stay_arrival: cell.min_stay_arrival,
      max_stay: cell.max_stay,
      closed_to_arrival: cell.closed_to_arrival,
      closed_to_departure: cell.closed_to_departure,
      stop_sell: cell.stop_sell,
    };
    const payload: RestrictionValue = {};
    for (const field of RESTRICTION_FIELDS) {
      if (!wanted.has(field)) continue;
      const value = source[field];
      // A cleared restriction still has to be stated, or the far side keeps the
      // old value. Channex reject nulls, so a cleared field sends its neutral
      // value rather than nothing.
      if (value === null || value === undefined) {
        if (field === "rate") continue;
        payload[field] = field === "max_stay" ? 0 : field.startsWith("min_stay") ? 1 : false;
        continue;
      }
      payload[field] = value;
    }

    if (Object.keys(payload).length === 0) {
      unmapped.push(row.id);
      continue;
    }

    const list = byPlan.get(plan.channex_rate_plan_id) ?? [];
    list.push({ date: row.date, payload, signature: signatureOf(payload) });
    byPlan.set(plan.channex_rate_plan_id, list);
  }

  const values: RestrictionValue[] = [];
  for (const [channexRatePlanId, entries] of byPlan) {
    entries.sort((a, b) => a.date.localeCompare(b.date));
    let span: { value: RestrictionValue; signature: string; date_to: string } | null = null;
    for (const entry of entries) {
      if (span && span.signature === entry.signature && addDays(span.date_to, 1) === entry.date) {
        span.value.date_to = entry.date;
        span.date_to = entry.date;
        continue;
      }
      const value: RestrictionValue = {
        property_id: property.channex_property_id as string,
        rate_plan_id: channexRatePlanId,
        date_from: entry.date,
        date_to: entry.date,
        ...entry.payload,
      };
      values.push(value);
      span = { value, signature: entry.signature, date_to: entry.date };
    }
  }
  return { values, unmapped };
}

function signatureOf(payload: RestrictionValue): string {
  // Which fields are present matters as much as their values: two dates only
  // merge into one range when they carry the same fields as well as the same
  // numbers.
  return RESTRICTION_FIELDS.map((f) => (f in payload ? `${f}=${String(payload[f])}` : `${f}:absent`)).join(";");
}
