import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { flushProperty } from "@/lib/outbox";
import { EDITABLE_FIELDS, fieldBelongsToRatePlan, type EditableField } from "@/lib/types";

export const dynamic = "force-dynamic";

type IncomingEdit = {
  room_type_id: string;
  rate_plan_id: string | null;
  date: string;
  field: EditableField;
  value: string | boolean | null;
};

const INT_FIELDS = new Set<EditableField>(["availability", "min_stay_through", "min_stay_arrival", "max_stay"]);
const BOOL_FIELDS = new Set<EditableField>(["closed_to_arrival", "closed_to_departure", "stop_sell"]);

function coerce(field: EditableField, value: string | boolean | null): number | string | boolean | null {
  if (BOOL_FIELDS.has(field)) return value === true || value === "true";
  if (value === null || value === "" || value === false) return null;
  if (field === "rate") {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (INT_FIELDS.has(field)) {
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

export async function POST(request: Request) {
  let payload: { property_id?: string; edits?: IncomingEdit[] };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Body was not valid JSON" }, { status: 400 });
  }

  const propertyId = payload.property_id;
  const edits = payload.edits ?? [];
  if (!propertyId) return NextResponse.json({ error: "property_id is required" }, { status: 400 });
  if (edits.length === 0) return NextResponse.json({ error: "No edits sent" }, { status: 400 });

  const supabase = db();

  // Nothing is trusted from the browser. Room types and rate plans have to
  // belong to this property or the write is refused outright.
  const { data: roomTypes, error: rtError } = await supabase
    .from("room_types")
    .select("id")
    .eq("property_id", propertyId);
  if (rtError) return NextResponse.json({ error: rtError.message }, { status: 500 });

  const roomTypeIds = new Set((roomTypes ?? []).map((r) => r.id as string));
  const { data: ratePlans } = roomTypeIds.size
    ? await supabase.from("rate_plans").select("id, room_type_id").in("room_type_id", [...roomTypeIds])
    : { data: [] as { id: string; room_type_id: string }[] };
  const planOwner = new Map((ratePlans ?? []).map((p) => [p.id as string, p.room_type_id as string]));

  type Cell = {
    room_type_id: string;
    rate_plan_id: string | null;
    date: string;
    fields: Partial<Record<EditableField, number | string | boolean | null>>;
  };
  const cells = new Map<string, Cell>();

  for (const edit of edits) {
    if (!EDITABLE_FIELDS.includes(edit.field)) {
      return NextResponse.json({ error: `Unknown field ${edit.field}` }, { status: 400 });
    }
    if (!roomTypeIds.has(edit.room_type_id)) {
      return NextResponse.json({ error: "A room type does not belong to this property" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(edit.date)) {
      return NextResponse.json({ error: `Bad date ${edit.date}` }, { status: 400 });
    }

    const needsPlan = fieldBelongsToRatePlan(edit.field);
    const ratePlanId = needsPlan ? edit.rate_plan_id : null;
    if (needsPlan) {
      if (!ratePlanId || planOwner.get(ratePlanId) !== edit.room_type_id) {
        return NextResponse.json({ error: `${edit.field} needs a rate plan on this room type` }, { status: 400 });
      }
    }

    const key = [edit.room_type_id, ratePlanId ?? "-", edit.date].join("|");
    const cell = cells.get(key) ?? {
      room_type_id: edit.room_type_id,
      rate_plan_id: ratePlanId,
      date: edit.date,
      fields: {},
    };
    cell.fields[edit.field] = coerce(edit.field, edit.value);
    cells.set(key, cell);
  }

  const list = [...cells.values()];
  const dates = [...new Set(list.map((c) => c.date))].sort();

  // Existing rows are read first so an upsert of one field does not blank the
  // others sitting in the same row.
  const { data: existing, error: exError } = await supabase
    .from("ari")
    .select("*")
    .eq("property_id", propertyId)
    .gte("date", dates[0])
    .lte("date", dates[dates.length - 1]);
  if (exError) return NextResponse.json({ error: exError.message }, { status: 500 });

  const existingByKey = new Map<string, Record<string, unknown>>();
  for (const row of existing ?? []) {
    existingByKey.set(
      [row.room_type_id, row.rate_plan_id ?? "-", row.date].join("|"),
      row as Record<string, unknown>,
    );
  }

  const rows = list.map((cell) => {
    const key = [cell.room_type_id, cell.rate_plan_id ?? "-", cell.date].join("|");
    const prior = existingByKey.get(key) ?? {};
    return {
      property_id: propertyId,
      room_type_id: cell.room_type_id,
      rate_plan_id: cell.rate_plan_id,
      date: cell.date,
      availability: pick(prior, cell.fields, "availability"),
      rate: pick(prior, cell.fields, "rate"),
      min_stay_through: pick(prior, cell.fields, "min_stay_through"),
      min_stay_arrival: pick(prior, cell.fields, "min_stay_arrival"),
      max_stay: pick(prior, cell.fields, "max_stay"),
      closed_to_arrival: pick(prior, cell.fields, "closed_to_arrival"),
      closed_to_departure: pick(prior, cell.fields, "closed_to_departure"),
      stop_sell: pick(prior, cell.fields, "stop_sell"),
    };
  });

  const { data: highWater } = await supabase
    .from("outbox")
    .select("id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const beforeId = (highWater?.id as number | undefined) ?? 0;

  const { error: upsertError } = await supabase
    .from("ari")
    .upsert(rows, { onConflict: "room_type_id,rate_plan_id,date" });
  if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

  // The trigger, not this route, decides what became a delta. Counting what it
  // wrote is how the grid reports honestly instead of guessing.
  const { count: queued } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .gt("id", beforeId);

  // Drain what this edit enqueued. The delta still goes trigger -> outbox ->
  // batched call; this only stops the queue sitting there until something else
  // happens to run the worker. Without it a price change in the grid reaches
  // Channex whenever the next worker run happens to be, which during a live
  // review looks like nothing happening at all.
  //
  // A Channex failure must not fail the save. The row is already written and
  // the outbox keeps the delta with its attempt count, so the worker retries.
  let calls: { path: string; values: number; task_id: string | null; ok: boolean }[] = [];
  try {
    const report = await flushProperty(propertyId);
    calls = report.calls.map((c) => ({ path: c.path, values: c.values, task_id: c.task_id, ok: c.ok }));
  } catch (err) {
    console.error("[api/ari] flush after save failed, delta stays queued:", err);
  }

  return NextResponse.json({ rows: rows.length, queued: queued ?? 0, calls });
}

function pick(
  prior: Record<string, unknown>,
  fields: Partial<Record<EditableField, unknown>>,
  field: EditableField,
) {
  if (field in fields) return fields[field] ?? null;
  const value = prior[field];
  return value === undefined ? null : value;
}
