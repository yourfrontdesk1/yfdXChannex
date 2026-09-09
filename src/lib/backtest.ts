import { createClient } from "@supabase/supabase-js";
import { db } from "./db";
import { PARKSIDE_PROPERTY_ID, PARKSIDE_ROOMS } from "./parkside";

/**
 * What the engine would have asked, against what the building actually got.
 *
 * This is a diagnostic, not a proof, and the difference matters. Nobody can know
 * whether a higher price would still have sold, so this does not claim extra
 * revenue. What it can say honestly is where flat pricing was obviously wrong:
 * nights that sold out early while being charged the same as an empty Tuesday,
 * and nights that never sold while being charged as if they had.
 */

const PORTAL_TYPE: Record<string, string> = {
  "Studio Apartment": "studio",
  "Executive Studio": "executive_studio",
  "One Bedroom Apartment": "one_bed",
  "Two Bedroom Apartment": "two_bed",
};

export type Backtest = {
  nights: number;
  days_back: number;
  sold_out_nights: number;
  sold_out_underpriced: number;
  sold_out_gap_per_night: number | null;
  empty_nights: number;
  empty_overpriced: number;
  empty_gap_per_night: number | null;
  average_achieved: number | null;
  average_engine_ask: number | null;
  verdict: string;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

function portalClient() {
  const url = process.env.PORTAL_SUPABASE_URL;
  const key = process.env.PORTAL_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("PORTAL_SUPABASE_URL and PORTAL_SERVICE_ROLE_KEY are not set");
  return createClient(url, key, { auth: { persistSession: false } });
}

/** The same shape the live engine uses, so the test is of the engine and not of a copy of it. */
function occupancyFactor(sold: number): number {
  if (sold <= 0.15) return 0.92;
  if (sold <= 0.4) return 0.97;
  if (sold <= 0.6) return 1.02;
  if (sold <= 0.8) return 1.1;
  return 1.22;
}

export async function backtestParkside(daysBack = 180, leadDays = 14): Promise<Backtest> {
  const hub = db();
  const portal = portalClient();

  const { data: rules } = await hub.from("pricing_rules").select("*");
  const { data: roomTypes } = await hub
    .from("room_types")
    .select("id, name, count_of_rooms")
    .eq("property_id", PARKSIDE_PROPERTY_ID);

  const ruleOf = new Map((rules ?? []).map((r) => [r.room_type_id as string, r]));

  const { data: apartments } = await portal.from("properties").select("id, type").in("room_number", PARKSIDE_ROOMS);
  const typeOf = new Map((apartments ?? []).map((a) => [a.id as string, a.type as string]));

  const from = iso(new Date(Date.now() - daysBack * 86400000));
  const to = iso(new Date(Date.now() - 86400000));

  const { data: bookings } = await portal
    .from("bookings")
    .select("property_id, check_in, check_out, created_at, status, is_active, no_show, amount_after_tax, amount_before_tax, balance_amount")
    .gte("check_out", from)
    .lte("check_in", to)
    .in("property_id", (apartments ?? []).map((a) => a.id));

  const live = (bookings ?? []).filter(
    (b) => b.is_active && b.status !== "cancelled" && !b.no_show && b.check_in && b.check_out,
  );

  // For every past night: how many of each type were sold, how many had been
  // sold by the lead time we are testing, and what was actually charged.
  type NightRow = { units: number; soldFinal: number; soldAtLead: number; rates: number[] };
  const nights = new Map<string, Map<string, NightRow>>();

  const unitsOfType: Record<string, number> = {};
  for (const a of apartments ?? []) unitsOfType[a.type as string] = (unitsOfType[a.type as string] ?? 0) + 1;

  for (const b of live) {
    const type = typeOf.get(b.property_id as string);
    if (!type) continue;
    const nightsInStay =
      (Date.parse(`${b.check_out}T00:00:00Z`) - Date.parse(`${b.check_in}T00:00:00Z`)) / 86400000;
    if (nightsInStay <= 0) continue;
    const total = Number(b.amount_after_tax ?? b.amount_before_tax ?? b.balance_amount ?? 0);
    const nightly = total > 0 ? total / nightsInStay : null;
    if (nightly !== null && (nightly < 35 || nightly > 500)) continue;

    const madeAt = b.created_at ? Date.parse(b.created_at as string) : null;

    for (let i = 0; i < nightsInStay; i++) {
      const date = iso(new Date(Date.parse(`${b.check_in}T00:00:00Z`) + i * 86400000));
      if (date < from || date > to) continue;
      if (!nights.has(date)) nights.set(date, new Map());
      const byType = nights.get(date)!;
      if (!byType.has(type)) {
        byType.set(type, { units: unitsOfType[type] ?? 0, soldFinal: 0, soldAtLead: 0, rates: [] });
      }
      const row = byType.get(type)!;
      row.soldFinal++;
      if (nightly !== null) row.rates.push(nightly);
      const leadCutoff = Date.parse(`${date}T00:00:00Z`) - leadDays * 86400000;
      if (madeAt !== null && madeAt <= leadCutoff) row.soldAtLead++;
    }
  }

  let soldOut = 0;
  let soldOutUnder = 0;
  let soldOutGap = 0;
  let empty = 0;
  let emptyOver = 0;
  let emptyGap = 0;
  let achievedSum = 0;
  let askSum = 0;
  let counted = 0;

  for (const [, byType] of nights) {
    for (const [typeName, row] of byType) {
      const roomType = (roomTypes ?? []).find((r) => PORTAL_TYPE[r.name as string] === typeName);
      const rule = roomType ? ruleOf.get(roomType.id as string) : null;
      if (!rule || row.rates.length === 0 || row.units === 0) continue;

      const achieved = row.rates.reduce((a, b) => a + b, 0) / row.rates.length;
      // What the engine would have asked at the lead time, on that night's
      // real occupancy at that moment.
      const ask = Math.round(
        Math.min(
          Number(rule.ceiling_rate),
          Math.max(Number(rule.floor_rate), Number(rule.base_rate) * occupancyFactor(row.soldAtLead / row.units)),
        ),
      );

      counted++;
      achievedSum += achieved;
      askSum += ask;

      if (row.soldFinal >= row.units) {
        soldOut++;
        if (ask > achieved) { soldOutUnder++; soldOutGap += ask - achieved; }
      }
      if (row.soldFinal === 0) {
        empty++;
        if (ask < achieved) { emptyOver++; emptyGap += achieved - ask; }
      }
    }
  }

  const averageAchieved = counted ? Math.round(achievedSum / counted) : null;
  const averageAsk = counted ? Math.round(askSum / counted) : null;

  return {
    nights: counted,
    days_back: daysBack,
    sold_out_nights: soldOut,
    sold_out_underpriced: soldOutUnder,
    sold_out_gap_per_night: soldOutUnder ? Math.round(soldOutGap / soldOutUnder) : null,
    empty_nights: empty,
    empty_overpriced: emptyOver,
    empty_gap_per_night: emptyOver ? Math.round(emptyGap / emptyOver) : null,
    average_achieved: averageAchieved,
    average_engine_ask: averageAsk,
    verdict:
      soldOutUnder === 0 && emptyOver === 0
        ? "No clear evidence either way in this window."
        : `On ${soldOutUnder} room type nights that sold out, the engine would have asked more than was charged. It cannot be claimed those would still have sold, only that they were priced as if demand were ordinary.`,
  };
}
