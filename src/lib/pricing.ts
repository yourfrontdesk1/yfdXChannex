import { createClient } from "@supabase/supabase-js";
import { db } from "./db";
import { PARKSIDE_PROPERTY_ID, PARKSIDE_ROOMS } from "./parkside";

/**
 * What a night is worth.
 *
 * These fourteen apartments have never really been priced. Looking at what they
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
  ladder_lifted: number;
  average: number | null;
  error: string | null;
};

/**
 * The studio ladder, cheapest first.
 *
 * Each room type prices off its own availability, which is right on its own and
 * wrong in a shop window. On a night where all three balcony studios are gone
 * and the five executive studios are empty, the engine pushes the studio up and
 * the executive studio down, and Booking.com then shows the larger flat for
 * forty pounds less than the smaller one on the same page. No rung is allowed
 * to sit below the rung beneath it. The one and two bedroom flats are left out:
 * they are different products with their own demand, not steps on this ladder.
 */
const LADDER = ["Standard Studio", "Studio Apartment", "Executive Studio"] as const;

/**
 * What the engine decides is what Victory Suites keeps. What Booking.com shows a
 * guest has to carry two more things on top.
 *
 * Commission is taken OFF the gross, so recovering it is a division and not a
 * multiplication. Adding fifteen percent to £100 gives £115, and fifteen percent
 * of £115 is £17.25, so £97.75 comes back and the fifteen was never recovered.
 * £100 / 0.85 is £117.65, and that does come back as £100.
 *
 * Tourist tax is per person per night, so it is added after the commission
 * rather than before it: it is a pass through, not revenue to be marked up. The
 * head count used is what the rate plan is quoted for, because a per room price
 * cannot know how many people will actually turn up.
 */
async function publishedPrice(net: number, occupancy: number, commissionPct: number, taxPerPerson: number): Promise<number> {
  const rate = Math.max(0, Math.min(90, commissionPct)) / 100;
  const grossed = rate > 0 ? net / (1 - rate) : net;
  return Math.round(grossed + taxPerPerson * Math.max(1, occupancy));
}

/**
 * The same journey backwards.
 *
 * Everything the engine reasons about is net, but what is stored and read back
 * is the published price. Comparing one against the other anchors the damping to
 * a number a fifth too high, and because the damping then only lets the price
 * move a little each run, it climbs instead of settling. That is exactly what
 * happened the first time this went in.
 */
function netOf(published: number, occupancy: number, commissionPct: number, taxPerPerson: number): number {
  const rate = Math.max(0, Math.min(90, commissionPct)) / 100;
  const withoutTax = published - taxPerPerson * Math.max(1, occupancy);
  return Math.max(0, rate > 0 ? withoutTax * (1 - rate) : withoutTax);
}

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
  // Wider than it was, deliberately. The old spread ran 0.92 to 1.22, a range of
  // thirty percent across a completely empty night and a nearly full one, which
  // is a rate card with a slight opinion rather than a price that responds. An
  // empty night four weeks out is worth cutting hard, because an unsold night
  // earns nothing at all, and the last room on a full night is worth what
  // somebody will pay for the last room.
  if (sold <= 0.15) return 0.78;
  if (sold <= 0.3) return 0.86;
  if (sold <= 0.45) return 0.94;
  if (sold <= 0.6) return 1.04;
  if (sold <= 0.75) return 1.16;
  if (sold <= 0.9) return 1.32;
  return 1.5;
}

/** When the whole building is filling, the room type stops being the only signal. */
function compressionFactor(buildingSold: number): number {
  // The building filling is the strongest signal there is, because it means the
  // town is busy rather than just this room type. It cuts both ways: a dead week
  // across every apartment is not a week to hold out on.
  if (buildingSold >= 0.9) return 1.18;
  if (buildingSold >= 0.8) return 1.1;
  if (buildingSold >= 0.65) return 1.04;
  if (buildingSold <= 0.2) return 0.92;
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

/**
 * A known event on the night, weighted by how big it is judged to be.
 *
 * Only real ones count. Gibraltar has something on almost every night, so
 * lifting every night by two percent moved nothing except the average, which is
 * noise wearing the costume of a signal. Below the threshold an event is
 * ignored, and above it the lift is meaningful.
 */
const EVENT_THRESHOLD = 6;

function eventFactor(scores: number[]): number {
  const real = scores
    .map((s) => (Number.isFinite(s) ? Math.min(Math.max(s, 0), 10) : 0))
    .filter((s) => s >= EVENT_THRESHOLD);
  if (real.length === 0) return 1.0;
  const best = Math.max(...real);
  // 6 lifts nothing, 10 lifts a tenth.
  return 1 + ((best - EVENT_THRESHOLD) / (10 - EVENT_THRESHOLD)) * 0.1;
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
    .select("id, name, room_type_id, ota_rate_plan_code, occupancy")
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

  const { data: cfg } = await hub.from("hub_config").select("key, value");
  const setting = (k: string, fallback: number) => {
    const v = (cfg ?? []).find((c) => c.key === k)?.value;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const commissionPct = setting("channel_commission_pct", 0);
  const taxPerPerson = setting("tourist_tax_per_person", 0);
  const occupancyOf = new Map<string, number>((plans ?? []).map((p) => [p.id as string, Number(p.occupancy ?? 2)]));

  const rows: { property_id: string; room_type_id: string; rate_plan_id: string; date: string; rate: number }[] = [];
  const logs: Record<string, unknown>[] = [];
  let unchanged = 0;
  let damped = 0;
  let ladderLifted = 0;
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

    const priced: {
      rtId: string;
      planId: string;
      name: string;
      price: number;
      floor: number;
      ceiling: number;
      was: number | null | undefined;
      log: Record<string, unknown>;
    }[] = [];

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
      // Read back as net, because that is what the rest of this reasons in.
      const storedGross = currentPrice.get(`${planId}|${date}`);
      const was =
        storedGross === undefined || storedGross === null
          ? storedGross
          : netOf(Number(storedGross), Number(occupancyOf.get(planId) ?? 2), commissionPct, taxPerPerson);
      const step = Number(rule.max_step_pct ?? 5) / 100;
      let price = target;
      if (was !== undefined && was !== null && was > 0) {
        const highest = Math.round(was * (1 + step));
        const lowest = Math.round(was * (1 - step));
        price = Math.min(highest, Math.max(lowest, target));
        price = Math.round(Math.min(ceiling, Math.max(floor, price)));
        if (price !== target) damped++;
      }

      priced.push({
        rtId: rt.id as string,
        planId,
        name: rt.name as string,
        price,
        floor,
        ceiling,
        was,
        log: {
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
        },
      });
    }

    // Walk the ladder upward, so a lift on one rung carries to the next.
    for (let i = 1; i < LADDER.length; i++) {
      const lower = priced.find((p) => p.name === LADDER[i - 1]);
      const upper = priced.find((p) => p.name === LADDER[i]);
      if (!lower || !upper || upper.price >= lower.price) continue;
      // Its own ceiling still wins. Better a narrow gap than a rate we said we
      // would never exceed.
      const lifted = Math.round(Math.min(upper.ceiling, lower.price));
      if (lifted === upper.price) continue;
      (upper.log.factors as Record<string, unknown>).ladder_lifted_from = upper.price;
      upper.price = lifted;
      upper.log.price = lifted;
      ladderLifted++;
    }

    for (const p of priced) {
      considered++;
      if (p.price === Math.round(p.floor)) atFloor++;
      if (p.price === Math.round(p.ceiling)) atCeiling++;

      // What is stored and sent is the published price, so that is what the
      // comparison has to be against. Comparing the net against it means every
      // night looks unchanged and the uplift never leaves.
      const published = await publishedPrice(p.price, occupancyOf.get(p.planId) ?? 2, commissionPct, taxPerPerson);
      sum += published;

      const storedNow = currentPrice.get(`${p.planId}|${date}`);
      if (storedNow !== undefined && storedNow !== null && Math.round(Number(storedNow)) === published) { unchanged++; continue; }

      rows.push({ property_id: PARKSIDE_PROPERTY_ID, room_type_id: p.rtId, rate_plan_id: p.planId, date, rate: published });
      (p.log.factors as Record<string, unknown>).net = p.price;
      (p.log.factors as Record<string, unknown>).commission_pct = commissionPct;
      (p.log.factors as Record<string, unknown>).tourist_tax = taxPerPerson * (occupancyOf.get(p.planId) ?? 2);

      for (const derivedId of derivedPlansOf.get(p.rtId) ?? []) {
        // The discount comes off what we keep, not off the tax and the
        // commission, so it is worked out net and grossed up the same way.
        const derivedNet = Math.round(Math.max(p.floor, p.price * NON_REFUNDABLE_DISCOUNT));
        const derived = await publishedPrice(derivedNet, occupancyOf.get(derivedId) ?? 2, commissionPct, taxPerPerson);
        const derivedWas = currentPrice.get(`${derivedId}|${date}`);
        if (derivedWas !== undefined && derivedWas !== null && Math.round(derivedWas) === derived) continue;
        rows.push({ property_id: PARKSIDE_PROPERTY_ID, room_type_id: p.rtId, rate_plan_id: derivedId, date, rate: derived });
      }
      logs.push(p.log);
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
    ladder_lifted: ladderLifted,
    average: considered === 0 ? null : Math.round(sum / considered),
    error: null,
  };
}
