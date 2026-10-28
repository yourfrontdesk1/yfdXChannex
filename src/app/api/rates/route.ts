import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The pass-through. YourFrontDesk owns pricing for a property the hub does not
 * compute (managed_pricing = false); it POSTs the published nightly rate per
 * room type and date, and the hub only stores it and lets the existing ari
 * trigger push it to Channex. The hub computes nothing: the number sent is the
 * number the guest sees, no gross-up, no tax added.
 *
 * Body: { property_id, rates: [{ room_type, rate_plan?, date, rate }] }, up to
 * 1000 rows. room_type is the hub room_types.id or its exact name. rate_plan is
 * optional: the hub rate_plans.id or its exact name ("Flexible",
 * "Non-refundable", "Weekly", "Wifi", "Monthly"); omitted, it targets the
 * primary plan. rate is published GBP.
 * Idempotent: a row whose rate already matches is left untouched, so no outbox
 * churn and nothing re-sent to Booking.com.
 */

type RateRow = { room_type?: string; rate_plan?: string; date?: string; rate?: number };
// rates carries the primary plan (Flexible) with no rate_plan; plan_rates
// carries the other plans (Non-refundable, Weekly, Monthly, Wifi), each naming
// its rate_plan. Both are processed the same way; plan_rates rows simply have
// rate_plan set. YourFrontDesk owns the prices; the hub only stores and passes.
type RatesBody = { property_id?: string; rates?: RateRow[]; plan_rates?: RateRow[] };

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(request: Request): boolean {
  const expected = process.env.WORKER_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  const header = request.headers.get("x-worker-secret") ?? "";
  return header !== "" && safeEqual(header, expected);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: RatesBody = {};
  try {
    body = (await request.json()) as RatesBody;
  } catch {
    return NextResponse.json({ error: "No JSON body" }, { status: 400 });
  }

  const propertyId = typeof body.property_id === "string" ? body.property_id.trim() : "";
  const baseRows = Array.isArray(body.rates) ? body.rates : [];
  const planRows = Array.isArray(body.plan_rates) ? body.plan_rates : [];
  const rows = [...baseRows, ...planRows];
  if (!propertyId) return NextResponse.json({ error: "property_id is required" }, { status: 400 });
  if (rows.length === 0) return NextResponse.json({ applied: 0, unchanged: 0, skipped: 0, errors: [], by_plan: {} });
  if (rows.length > 6000) return NextResponse.json({ error: "At most 6000 rates per call" }, { status: 400 });

  const supabase = db();

  // Resolve this property's room types once (by id and by exact name), and the
  // single selling plan per type (the one carrying an OTA code; that is what
  // reaches Booking.com).
  const { data: roomTypes, error: rtErr } = await supabase
    .from("room_types")
    .select("id, name")
    .eq("property_id", propertyId);
  if (rtErr) return NextResponse.json({ error: `Room types: ${rtErr.message}` }, { status: 500 });
  if (!roomTypes || roomTypes.length === 0) {
    return NextResponse.json({ error: "No room types for that property" }, { status: 404 });
  }
  const byId = new Map(roomTypes.map((r) => [r.id as string, r.id as string]));
  const byName = new Map(roomTypes.map((r) => [String(r.name), r.id as string]));

  const { data: plans } = await supabase
    .from("rate_plans")
    .select("id, room_type_id, name, ota_rate_plan_code, is_primary")
    .in("room_type_id", roomTypes.map((r) => r.id));
  // Default selling plan per room, used only when a row names no rate_plan:
  // the primary (Flexible), else any OTA-coded plan. Once several plans per room
  // carry OTA codes (Flexible, Non-refundable, Weekly, Wifi, Monthly), a row
  // without rate_plan would be ambiguous, so the caller should name the plan;
  // the default stays the primary for backward compatibility.
  const planOf = new Map<string, string>();
  const plansByRoom = new Map<string, { id: string; name: string }[]>();
  for (const p of plans ?? []) {
    const rt = p.room_type_id as string;
    if (p.is_primary) planOf.set(rt, p.id as string);
    else if (!planOf.has(rt) && p.ota_rate_plan_code) planOf.set(rt, p.id as string);
    const list = plansByRoom.get(rt) ?? [];
    list.push({ id: p.id as string, name: String(p.name) });
    plansByRoom.set(rt, list);
  }

  const errors: string[] = [];
  // Plan names the caller sent that do not exist for the room (e.g. a plan a
  // customer added that the hub has not been given). Surfaced per name in
  // by_plan rather than dropped silently, so the sender can see it never landed.
  const unresolved = new Map<string, number>();
  // Normalise + resolve every row first.
  type Resolved = { room_type_id: string; rate_plan_id: string; date: string; rate: number };
  const resolved: Resolved[] = [];
  for (const [i, r] of rows.entries()) {
    const key = typeof r.room_type === "string" ? r.room_type.trim() : "";
    const rtId = byId.get(key) ?? byName.get(key);
    if (!rtId) { errors.push(`row ${i}: unknown room_type "${key}"`); continue; }
    // A row may name which rate plan it is pricing (hub rate_plans.id or its
    // exact name, e.g. "Non-refundable"). Without it, the primary plan is used.
    let planId: string | undefined;
    const rpKey = typeof r.rate_plan === "string" ? r.rate_plan.trim() : "";
    if (rpKey) {
      const list = plansByRoom.get(rtId) ?? [];
      const match = list.find((p) => p.id === rpKey) ?? list.find((p) => p.name === rpKey);
      if (!match) { unresolved.set(rpKey, (unresolved.get(rpKey) ?? 0) + 1); continue; }
      planId = match.id;
    } else {
      planId = planOf.get(rtId);
    }
    if (!planId) { errors.push(`row ${i}: no sellable rate plan for "${key}"`); continue; }
    if (typeof r.date !== "string" || !DATE.test(r.date)) { errors.push(`row ${i}: bad date`); continue; }
    const rate = Number(r.rate);
    if (!Number.isFinite(rate) || rate <= 0) { errors.push(`row ${i}: bad rate`); continue; }
    resolved.push({ room_type_id: rtId, rate_plan_id: planId, date: r.date, rate: Math.round(rate) });
  }

  // by_plan starts with any unresolved plan names, so they are visible even when
  // nothing resolved; applied/unchanged are added below.
  const idToName = new Map<string, string>();
  for (const list of plansByRoom.values()) for (const p of list) idToName.set(p.id, p.name);
  const byPlan: Record<string, { applied: number; unchanged: number; unresolved?: number }> = {};
  for (const [name, count] of unresolved) (byPlan[name] ??= { applied: 0, unchanged: 0 }).unresolved = count;

  if (resolved.length === 0) {
    return NextResponse.json({ applied: 0, unchanged: 0, skipped: rows.length, errors, by_plan: byPlan });
  }

  // Idempotency: read current rates for exactly these (plan,date) and only write
  // the ones that actually change, so unchanged values send nothing onward.
  const dates = [...new Set(resolved.map((r) => r.date))].sort();
  const planIds = [...new Set(resolved.map((r) => r.rate_plan_id))];
  const current = new Map<string, number>();
  for (let off = 0; ; off += 1000) {
    const { data: page, error } = await supabase
      .from("ari")
      .select("rate_plan_id, date, rate")
      .eq("property_id", propertyId)
      .in("rate_plan_id", planIds)
      .gte("date", dates[0])
      .lte("date", dates[dates.length - 1])
      .range(off, off + 999);
    if (error) return NextResponse.json({ error: `Reading ari: ${error.message}` }, { status: 500 });
    for (const row of page ?? []) current.set(`${row.rate_plan_id}|${row.date}`, Number(row.rate));
    if (!page || page.length < 1000) break;
  }

  const changed = resolved.filter((r) => current.get(`${r.rate_plan_id}|${r.date}`) !== r.rate);
  const unchanged = resolved.length - changed.length;

  // Per-plan applied/unchanged counts, so the caller can see each plan landed.
  for (const r of resolved) {
    const name = idToName.get(r.rate_plan_id) ?? r.rate_plan_id;
    const slot = (byPlan[name] ??= { applied: 0, unchanged: 0 });
    if (current.get(`${r.rate_plan_id}|${r.date}`) !== r.rate) slot.applied++;
    else slot.unchanged++;
  }

  let applied = 0;
  for (let i = 0; i < changed.length; i += 500) {
    const batch = changed.slice(i, i + 500).map((r) => ({
      property_id: propertyId,
      room_type_id: r.room_type_id,
      rate_plan_id: r.rate_plan_id,
      date: r.date,
      rate: r.rate,
    }));
    const { error } = await supabase.from("ari").upsert(batch, { onConflict: "room_type_id,rate_plan_id,date" });
    if (error) { errors.push(`upsert: ${error.message}`); break; }
    applied += batch.length;
  }

  return NextResponse.json({ applied, unchanged, skipped: rows.length - resolved.length, errors, by_plan: byPlan });
}
