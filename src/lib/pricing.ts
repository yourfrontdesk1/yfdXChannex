import { createClient } from "@supabase/supabase-js";
import { db } from "./db";
import { PARKSIDE_PROPERTY_ID, PARKSIDE_ROOMS } from "./parkside";

/**
 * What a night is worth.
 *
 * These twelve apartments have never really been priced. Looking at what they
 * actually achieved, day of week moves the rate by three percent and the season
 * barely moves it at all, which is not a market with no shape, it is a flat
 * price list. So the shape here comes from the two things that genuinely change:
 * how much of the room type is left on that night, and how close the night is.
 *
 * Everything is bounded by a floor and a ceiling per room type, held in
 * `pricing_rules` so the fence can move without a deploy, and every decision is
 * written to `pricing_log` so a price can be explained to an owner afterwards
 * rather than defended from memory.
 */

export type Horizon = "near" | "mid" | "far" | "all";

/** How far ahead each pass reaches. A night in 2027 does not move every ten minutes. */
const WINDOW: Record<Exclude<Horizon, "all">, [number, number]> = {
  near: [0, 14],
  mid: [15, 90],
  far: [91, 499],
};

export type PricingResult = {
  horizon: Horizon;
  from: string;
  to: string;
  nights_considered: number;
  prices_changed: number;
  unchanged: number;
  at_floor: number;
  at_ceiling: number;
  damped: number;
  average: number | null;
  error: string | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

/**
 * Pace. The single most useful idea worth taking from the revenue management
 * tools: a night is not cheap or dear because of how full it is, but because of
 * how full it is *compared with how full this hotel normally is at the same
 * distance out*. Sixty percent sold is strong at ninety days and weak at three.
 *
 * The curve is built from this building's own history, so it needs no outside
 * feed and no subscription.
 */
function paceFactor(sold: number, typical: number | undefined): number {
  if (typical === undefined || typical <= 0.02) return 1.0;
  const ratio = sold / typical;
  if (ratio >= 1.5) return 1.08;
  if (ratio >= 1.15) return 1.04;
  if (ratio <= 0.5) return 0.94;
  if (ratio <= 0.85) return 0.97;
  return 1.0;
}

/**
 * An orphan night: one or two free nights boxed in by sold ones. Almost nobody
 * is looking for exactly that stay, so it goes at a discount rather than sitting
 * there being the reason a room type shows as available and never sells.
 */
function orphanFactor(free: number, freeBefore: number, freeAfter: number): number {
  if (free <= 0) return 1.0;
  if (freeBefore === 0 && freeAfter === 0) return 0.88;
  return 1.0;
}

/**
 * The last unit of a room type is worth more than the first. Sold is the share
 * of that room type already gone for the night.
 */
function occupancyFactor(sold: number): number {
  if (sold <= 0.15) return 0.92;
  if (sold <= 0.4) return 0.97;
  if (sold <= 0.6) return 1.02;
  if (sold <= 0.8) return 1.1;
  return 1.22;
}

/** When the whole building is filling, the room type stops being the only signal. */
function compressionFactor(buildingSold: number): number {
  if (buildingSold >= 0.85) return 1.08;
  if (buildingSold >= 0.7) return 1.04;
  return 1.0;
}

/**
 * Close in, an empty night is a discount and a busy night is a premium. Far out
 * the rate is held slightly above base, because giving 2027 away cheaply is the
 * easiest money to lose and the hardest to notice.
 */
function leadFactor(daysOut: number, sold: number): number {
  if (daysOut <= 3) return sold >= 0.6 ? 1.08 : 0.9;
  if (daysOut <= 7) return sold >= 0.6 ? 1.05 : 0.94;
  if (daysOut <= 21) return sold >= 0.5 ? 1.02 : 0.97;
  if (daysOut <= 90) return 1.0;
  return 1.02;
}

/** A known event on the night, weighted by how big it is judged to be. */
function eventFactor(scores: number[]): number {
  if (scores.length === 0) return 1.0;
  const best = Math.max(...scores.map((s) => (Number.isFinite(s) ? Math.min(Math.max(s, 0), 10) : 3)));
  return 1 + best / 100;
}

function portalClient() {
  const url = process.env.PORTAL_SUPABASE_URL;
  const key = process.env.PORTAL_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("PORTAL_SUPABASE_URL and PORTAL_SERVICE_ROLE_KEY are not set");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function priceParkside(horizon: Horizon): Promise<PricingResult> {
  const hub = db();
  const today = new Date(`${iso(new Date())}T00:00:00Z`);
  const [firstOffset, lastOffset] = horizon === "all" ? [0, 499] : WINDOW[horizon];
  const from = iso(addDays(today, firstOffset));
  const to = iso(addDays(today, lastOffset));

  const { data: roomTypes, error: rtError } = await hub
    .from("room_types")
    .select("id, name, count_of_rooms")
    .eq("property_id", PARKSIDE_PROPERTY_ID);
  if (rtError) throw new Error(`Room types: ${rtError.message}`);

  const { data: rules, error: ruleError } = await hub.from("pricing_rules").select("*");
  if (ruleError) throw new Error(`Pricing rules: ${ruleError.message}`);
  const ruleOf = new Map((rules ?? []).map((r) => [r.room_type_id as string, r]));

  // Price the rate plan that Booking.com actually sells. The others carry no OTA
  // code, so pricing them would move nothing and only add noise to the outbox.
  const { data: plans, error: planError } = await hub
    .from("rate_plans")
    .select("id, name, room_type_id, ota_rate_plan_code")
    .in("room_type_id", (roomTypes ?? []).map((r) => r.id));
  if (planError) throw new Error(`Rate plans: ${planError.message}`);
  const sellingPlanOf = new Map(
    (plans ?? []).filter((p) => p.ota_rate_plan_code).map((p) => [p.room_type_id as string, p.id as string]),
  );
  // Plans with no OTA code of their own still get a price. A non refundable sits
  // a tenth under the flexible rate, which is what the discount is for: the guest
  // gives up the right to cancel and pays less for it. Leaving them holding seed
  // numbers is how a fake price gets published the day someone maps them.
  const NON_REFUNDABLE_DISCOUNT = 0.9;
  const derivedPlansOf = new Map<string, string[]>();
  for (const plan of plans ?? []) {
    if (plan.ota_rate_plan_code) continue;
    const key = plan.room_type_id as string;
    derivedPlansOf.set(key, [...(derivedPlansOf.get(key) ?? []), plan.id as string]);
  }

  // Availability and the current price, both paged: PostgREST stops at a
  // thousand rows and this window is bigger than that.
  const availability = new Map<string, number>();
  const currentPrice = new Map<string, number | null>();
  const PAGE = 1000;
  for (const withRates of [false, true]) {
    for (let offset = 0; ; offset += PAGE) {
      let query = hub
        .from("ari")
        .select("room_type_id, rate_plan_id, date, availability, rate")
        .eq("property_id", PARKSIDE_PROPERTY_ID)
        .gte("date", from)
        .lte("date", to)
        .order("date", { ascending: true })
        .range(offset, offset + PAGE - 1);
      query = withRates ? query.not("rate_plan_id", "is", null) : query.is("rate_plan_id", null);
      const { data: page, error } = await query;
      if (error) throw new Error(`Reading ari: ${error.message}`);
      for (const r of page ?? []) {
        if (withRates) currentPrice.set(`${r.rate_plan_id}|${r.date}`, r.rate === null ? null : Number(r.rate));
        else availability.set(`${r.room_type_id}|${r.date}`, r.availability ?? 0);
      }
      if (!page || page.length < PAGE) break;
    }
  }

  // How full this building normally is, by distance from arrival. Built from a
  // year of its own bookings, using when each one was made.
  const portal = portalClient();
  const yearAgo = iso(addDays(today, -365));
  const { data: apartments } = await portal.from("properties").select("id").in("room_number", PARKSIDE_ROOMS);
  const apartmentIds = (apartments ?? []).map((a) => a.id as string);
  const { data: history } = await portal
    .from("bookings")
    .select("check_in, check_out, created_at, status, is_active, no_show")
    .gte("check_in", yearAgo)
    .lt("check_in", iso(today))
    .in("property_id", apartmentIds.length ? apartmentIds : ["none"]);
  const soldByLead = new Map<number, { sold: number; of: number }>();
  const nightsSeen = new Map<string, { total: number; leads: number[] }>();
  for (const b of history ?? []) {
    if (!b.is_active || b.status === "cancelled" || b.no_show || !b.check_in || !b.check_out || !b.created_at) continue;
    const made = new Date(b.created_at as string);
    for (let d = new Date(`${b.check_in}T00:00:00Z`); iso(d) < (b.check_out as string); d = addDays(d, 1)) {
      const key = iso(d);
      const lead = Math.max(0, Math.round((d.getTime() - made.getTime()) / 86400000));
      if (!nightsSeen.has(key)) nightsSeen.set(key, { total: 0, leads: [] });
      const night = nightsSeen.get(key)!;
      night.total++;
      night.leads.push(lead);
    }
  }
  // For each distance out, the share of a night's eventual bookings that were
  // already made by then, averaged over every night in the year.
  const UNITS = 12;
  for (let lead = 0; lead <= 365; lead++) {
    let sold = 0;
    let of = 0;
    for (const night of nightsSeen.values()) {
      sold += night.leads.filter((l) => l >= lead).length;
      of += UNITS;
    }
    soldByLead.set(lead, { sold, of });
  }
  const typicalSoldAt = (lead: number) => {
    const row = soldByLead.get(Math.min(365, Math.max(0, lead)));
    return row && row.of > 0 ? row.sold / row.of : undefined;
  };

  // Events are Gibraltar wide, so they lift every room type on the night.
  const { data: events } = await portal
    .from("gib_events")
    .select("start_date, end_date, impact_score")
    .not("start_date", "is", null)
    .gte("start_date", addDays(new Date(`${from}T00:00:00Z`), -30).toISOString().slice(0, 10))
    .lte("start_date", to);
  const eventsOn = new Map<string, number[]>();
  for (const e of events ?? []) {
    const start = e.start_date as string;
    const end = (e.end_date as string) ?? start;
    for (let d = new Date(`${start}T00:00:00Z`); iso(d) <= end; d = addDays(d, 1)) {
      const key = iso(d);
      if (key < from || key > to) continue;
      if (!eventsOn.has(key)) eventsOn.set(key, []);
      eventsOn.get(key)!.push(Number(e.impact_score ?? 3));
    }
  }

  const nights = Array.from({ length: lastOffset - firstOffset + 1 }, (_, i) => iso(addDays(today, firstOffset + i)));

  const totalUnits = (roomTypes ?? []).reduce((sum, r) => sum + Number(r.count_of_rooms ?? 0), 0);

  const rows: { property_id: string; room_type_id: string; rate_plan_id: string; date: string; rate: number }[] = [];
  const logs: Record<string, unknown>[] = [];
  let unchanged = 0;
  let damped = 0;
  let atFloor = 0;
  let atCeiling = 0;
  let considered = 0;
  let sum = 0;

  for (const date of nights) {
    const freeInBuilding = (roomTypes ?? []).reduce(
      (sum, r) => sum + (availability.get(`${r.id}|${date}`) ?? 0),
      0,
    );
    const buildingSold = totalUnits === 0 ? 0 : 1 - freeInBuilding / totalUnits;
    const daysOut = Math.round((Date.parse(`${date}T00:00:00Z`) - today.getTime()) / 86400000);
    const evented = eventFactor(eventsOn.get(date) ?? []);

    for (const rt of roomTypes ?? []) {
      const rule = ruleOf.get(rt.id as string);
      const planId = sellingPlanOf.get(rt.id as string);
      if (!rule || rule.is_active === false || !planId) continue;

      const units = Number(rt.count_of_rooms ?? 0);
      const free = availability.get(`${rt.id}|${date}`) ?? 0;
      const sold = units === 0 ? 0 : 1 - free / units;

      const occupancy = occupancyFactor(sold);
      const compression = compressionFactor(buildingSold);
      const lead = leadFactor(daysOut, sold);
      const pace = paceFactor(sold, typicalSoldAt(daysOut));
      const orphan = orphanFactor(
        free,
        availability.get(`${rt.id}|${iso(addDays(new Date(`${date}T00:00:00Z`), -1))}`) ?? 1,
        availability.get(`${rt.id}|${iso(addDays(new Date(`${date}T00:00:00Z`), 1))}`) ?? 1,
      );

      const raw = Number(rule.base_rate) * occupancy * compression * lead * evented * pace * orphan;
      const floor = Number(rule.floor_rate);
      const ceiling = Number(rule.ceiling_rate);
      const target = Math.round(Math.min(ceiling, Math.max(floor, raw)));

      // Nothing lurches. A night walks toward what it is worth a few percent at
      // a time, so a listing never jumps in front of a guest who is watching it
      // and Booking.com never sees a price spasm.
      const was = currentPrice.get(`${planId}|${date}`);
      const step = Number(rule.max_step_pct ?? 5) / 100;
      let price = target;
      if (was !== undefined && was !== null && was > 0) {
        const highest = Math.round(was * (1 + step));
        const lowest = Math.round(was * (1 - step));
        price = Math.min(highest, Math.max(lowest, target));
        price = Math.round(Math.min(ceiling, Math.max(floor, price)));
        if (price !== target) damped++;
      }

      considered++;
      sum += price;
      if (price === Math.round(floor)) atFloor++;
      if (price === Math.round(ceiling)) atCeiling++;

      if (was !== undefined && was !== null && Math.round(was) === price) { unchanged++; continue; }

      rows.push({ property_id: PARKSIDE_PROPERTY_ID, room_type_id: rt.id as string, rate_plan_id: planId, date, rate: price });

      for (const derivedId of derivedPlansOf.get(rt.id as string) ?? []) {
        const derived = Math.round(Math.max(floor, price * NON_REFUNDABLE_DISCOUNT));
        const derivedWas = currentPrice.get(`${derivedId}|${date}`);
        if (derivedWas !== undefined && derivedWas !== null && Math.round(derivedWas) === derived) continue;
        rows.push({ property_id: PARKSIDE_PROPERTY_ID, room_type_id: rt.id as string, rate_plan_id: derivedId, date, rate: derived });
      }
      logs.push({
        property_id: PARKSIDE_PROPERTY_ID,
        room_type_id: rt.id,
        date,
        price,
        previous: was ?? null,
        factors: {
          base: Number(rule.base_rate), sold, occupancy, compression, lead, pace, orphan,
          event: evented, days_out: daysOut, raw: Math.round(raw), target,
          typical_sold_at_lead: typicalSoldAt(daysOut) ?? null,
        },
      });
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await hub.from("ari").upsert(rows.slice(i, i + 500), { onConflict: "room_type_id,rate_plan_id,date" });
    if (error) throw new Error(`Writing rates: ${error.message}`);
  }
  for (let i = 0; i < logs.length; i += 500) {
    await hub.from("pricing_log").insert(logs.slice(i, i + 500));
  }

  return {
    horizon,
    from,
    to,
    nights_considered: considered,
    prices_changed: rows.length,
    unchanged,
    at_floor: atFloor,
    at_ceiling: atCeiling,
    damped,
    average: considered === 0 ? null : Math.round(sum / considered),
    error: null,
  };
}
