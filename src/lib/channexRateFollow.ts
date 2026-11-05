import { channexRequest, remainingAriBudget } from "./channex";
import { db } from "./db";
import { enabled, record } from "./ops";
import { addDays } from "./dates";

/**
 * Keeps hub `ari` true to Channex when a price is changed on Channex itself.
 * Leon, 5 Nov 2026: "every time Chanix changes the price, you change the price
 * as well."
 *
 * Channex's ari event does not carry a dependable price and can arrive out of
 * order, so it is only a trigger. It marks the dates dirty; a one minute job then
 * asks Channex for the current rates in one call and copies what differs.
 *
 * Never pushes back. The write goes through absorb_channex_rates, which turns the
 * outbox trigger off for that one transaction, so copying a price cannot queue it
 * for Channex and cannot loop.
 *
 * The event also fires for the hub's own pushes, and user_id cannot tell them
 * apart because the hub and the dashboard can be the same Channex user. So a
 * night the hub has just queued or sent is left alone and looked at again next
 * time. Everything else that differs came from outside and is logged in
 * channex_price_changes with the old and new price.
 */

/** Pull when events have stopped this long, so a burst becomes one call. */
const QUIET_MS = 45_000;
/** Or this long after the first event, so steady pushes cannot delay it for ever. */
const MAX_WAIT_MS = 5 * 60_000;
/** A hub push may take this long to show in Channex's answer. */
const IN_FLIGHT_MS = 3 * 60_000;
/** The worker abandons a row after this many attempts; it is no longer in flight. */
const ABANDONED_ATTEMPTS = 8;
/** More differences than this in one pull is treated as a fault and not copied. */
const MAX_CHANGES = 2000;
/** Channex allow 500 days; an event with no dates looks a year ahead. */
const HORIZON_DAYS = 500;
const DEFAULT_DAYS = 365;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type AriEvent = { property_id?: string; user_id?: string | null; payload?: unknown };

/** Marks the event's dates dirty. Makes no Channex call, so a burst costs little. */
export async function markRatesDirty(event: AriEvent): Promise<{ marked: boolean; note?: string }> {
  if (!event.property_id) return { marked: false, note: "No property on the event" };
  const { data: property } = await db().from("properties").select("id").eq("channex_property_id", event.property_id).maybeSingle();
  if (!property) return { marked: false, note: "Not a property of ours" };

  const today = iso(new Date());
  const last = addDays(today, HORIZON_DAYS);
  const dates: string[] = [];
  for (const e of Array.isArray(event.payload) ? (event.payload as Record<string, unknown>[]) : []) {
    for (const key of ["date", "date_from", "date_to"]) {
      const v = e?.[key];
      if (typeof v === "string" && DATE.test(v.slice(0, 10))) dates.push(v.slice(0, 10));
    }
  }
  dates.sort();
  const from = dates.length ? (dates[0] < today ? today : dates[0]) : today;
  const to = dates.length ? dates[dates.length - 1] : addDays(today, DEFAULT_DAYS);
  if (to < today) return { marked: false, note: "All dates are in the past" };

  const { error } = await db().rpc("mark_channex_rates_dirty", {
    p_property: property.id,
    p_from: from,
    p_to: to > last ? last : to,
    p_user: event.user_id ?? null,
  });
  if (error) throw new Error(error.message);
  return { marked: true };
}

type Dirty = {
  property_id: string;
  from_date: string;
  to_date: string;
  first_event_at: string;
  last_event_at: string;
  last_user_id: string | null;
};

export type PullReport = {
  property_id: string;
  from: string;
  to: string;
  compared: number;
  changed: number;
  applied: number;
  in_flight: number;
  error: string | null;
};

/** Runs every minute: pulls and copies for each property whose events have settled. */
export async function pullDirtyRates(): Promise<PullReport[]> {
  const { data, error } = await db().from("channex_rates_dirty").select("*");
  if (error) throw new Error(error.message);
  const now = Date.now();
  const reports: PullReport[] = [];
  for (const row of (data ?? []) as Dirty[]) {
    const settled = now - Date.parse(row.last_event_at) >= QUIET_MS;
    const overdue = now - Date.parse(row.first_event_at) >= MAX_WAIT_MS;
    if (!settled && !overdue) continue;
    // Never eat the worker's share of the Channex limit: it is what sells rooms.
    if ((await remainingAriBudget(row.property_id, "/restrictions")) < 2) continue;
    const started = Date.now();
    const report = await pullProperty(row);
    await record("channex-rate-follow", started, report.error === null, report, report.error ?? undefined);
    reports.push(report);
  }
  return reports;
}

async function pullProperty(row: Dirty): Promise<PullReport> {
  const supabase = db();
  const report: PullReport = { property_id: row.property_id, from: row.from_date, to: row.to_date, compared: 0, changed: 0, applied: 0, in_flight: 0, error: null };

  const { data: property } = await supabase.from("properties").select("channex_property_id").eq("id", row.property_id).maybeSingle();
  if (!property?.channex_property_id) return { ...report, error: "Property has no Channex id" };

  const { data: types } = await supabase.from("room_types").select("id, name").eq("property_id", row.property_id);
  const typeName = new Map((types ?? []).map((t) => [t.id as string, t.name as string]));
  const { data: plans } = await supabase
    .from("rate_plans")
    .select("id, name, room_type_id, channex_rate_plan_id")
    .in("room_type_id", [...typeName.keys()])
    .not("channex_rate_plan_id", "is", null);
  const planByChannex = new Map((plans ?? []).map((p) => [p.channex_rate_plan_id as string, p]));

  const qs = new URLSearchParams({
    "filter[property_id]": property.channex_property_id as string,
    "filter[date][gte]": row.from_date,
    "filter[date][lte]": row.to_date,
    "filter[restrictions]": "rate",
  });
  const res = await channexRequest<{ data?: Record<string, Record<string, { rate?: string | number | null }>> }>(
    "GET",
    `/restrictions?${qs.toString()}`,
    undefined,
    { propertyId: row.property_id, retries: 0 },
  );
  // Left dirty: a failed read is tried again next minute.
  if (!res.ok || !res.body?.data) return { ...report, error: res.error ?? "Channex returned no data" };

  const current = new Map<string, number | null>();
  for (let off = 0; ; off += 1000) {
    const { data: page, error } = await supabase
      .from("ari")
      .select("rate_plan_id, date, rate")
      .eq("property_id", row.property_id)
      .not("rate_plan_id", "is", null)
      .gte("date", row.from_date)
      .lte("date", row.to_date)
      .order("id")
      .range(off, off + 999);
    if (error) return { ...report, error: `Reading ari: ${error.message}` };
    for (const r of page ?? []) current.set(`${r.rate_plan_id}|${r.date}`, r.rate === null ? null : Number(r.rate));
    if (!page || page.length < 1000) break;
  }

  // Nights the hub itself has queued or just sent. Channex may not show them yet,
  // so a difference there is the hub's own change on its way, not an outside one.
  const inFlight = new Set<string>();
  const since = new Date(Date.now() - IN_FLIGHT_MS).toISOString();
  for (let off = 0; ; off += 1000) {
    const { data: page, error } = await supabase
      .from("outbox")
      .select("rate_plan_id, date")
      .eq("property_id", row.property_id)
      .eq("kind", "rate")
      .gte("date", row.from_date)
      .lte("date", row.to_date)
      .or(`and(sent_at.is.null,attempts.lt.${ABANDONED_ATTEMPTS}),sent_at.gte.${since}`)
      .order("id")
      .range(off, off + 999);
    if (error) return { ...report, error: `Reading outbox: ${error.message}` };
    for (const r of page ?? []) inFlight.add(`${r.rate_plan_id}|${r.date}`);
    if (!page || page.length < 1000) break;
  }

  const rows: { room_type_id: string; rate_plan_id: string; date: string; old_rate: number | null; new_rate: number; room_type_name: string | null; rate_plan_name: string | null }[] = [];
  const skipped: string[] = [];
  for (const [channexPlan, nights] of Object.entries(res.body.data)) {
    const plan = planByChannex.get(channexPlan);
    if (!plan) continue;
    for (const [date, values] of Object.entries(nights)) {
      const rate = values?.rate === null || values?.rate === undefined ? NaN : Number(values.rate);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      report.compared++;
      const key = `${plan.id}|${date}`;
      const old = current.get(key) ?? null;
      if (old === rate) continue;
      if (inFlight.has(key)) { report.in_flight++; skipped.push(date); continue; }
      rows.push({
        room_type_id: plan.room_type_id as string,
        rate_plan_id: plan.id as string,
        date,
        old_rate: old,
        new_rate: rate,
        room_type_name: typeName.get(plan.room_type_id as string) ?? null,
        rate_plan_name: (plan.name as string) ?? null,
      });
    }
  }
  report.changed = rows.length;

  if (rows.length > MAX_CHANGES) {
    report.error = `${rows.length} prices differ from Channex in one pull, over the limit of ${MAX_CHANGES}. Nothing copied.`;
  } else if (rows.length) {
    const apply = await enabled("channex_rate_follow_apply");
    const { data: applied, error } = await supabase.rpc("absorb_channex_rates", {
      p_property: row.property_id,
      p_rows: rows,
      p_user: row.last_user_id,
      p_apply: apply,
    });
    if (error) return { ...report, error: `Copying: ${error.message}` };
    report.applied = Number(applied ?? 0);
  }

  // Finished with what this pull saw. An event that landed meanwhile keeps the row
  // dirty, and nights skipped as in flight are looked at again once they settle.
  if (skipped.length) {
    skipped.sort();
    await supabase
      .from("channex_rates_dirty")
      .update({ from_date: skipped[0], to_date: skipped[skipped.length - 1], first_event_at: new Date().toISOString(), last_event_at: new Date().toISOString() })
      .eq("property_id", row.property_id)
      .eq("last_event_at", row.last_event_at);
  } else {
    await supabase.from("channex_rates_dirty").delete().eq("property_id", row.property_id).eq("last_event_at", row.last_event_at);
  }
  return report;
}
