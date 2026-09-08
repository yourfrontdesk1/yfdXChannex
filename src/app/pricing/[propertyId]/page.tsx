import { redirect } from "next/navigation";
import Link from "next/link";
import { signedIn, authRequired } from "@/lib/session";
import { db } from "@/lib/db";
import { dateRange, today } from "@/lib/dates";

export const dynamic = "force-dynamic";

const NIGHTS = 21;
const MOVES = 25;

type Factors = {
  base: number; sold: number; occupancy: number; compression: number; lead: number;
  pace: number; orphan: number; event: number; days_out: number; raw: number; target: number;
  typical_sold_at_lead: number | null;
};

/** The one thing that moved this price the most, said the way a person would say it. */
function why(f: Factors): string {
  const pulls: [string, number][] = [
    ["how little is left", f.occupancy],
    ["the building filling up", f.compression],
    ["how close the night is", f.lead],
    ["booking faster than usual", f.pace],
    ["an event in town", f.event],
    ["an awkward single night", f.orphan],
  ];
  const strongest = pulls.reduce((a, b) => (Math.abs(b[1] - 1) > Math.abs(a[1] - 1) ? b : a));
  if (Math.abs(strongest[1] - 1) < 0.005) return "nothing much, it is sitting at base";
  return `${strongest[1] > 1 ? "up on" : "down on"} ${strongest[0]}`;
}

export default async function PricingPage({ params }: { params: Promise<{ propertyId: string }> }) {
  if (authRequired() && !(await signedIn())) redirect("/sign-in");
  const { propertyId } = await params;

  const supabase = db();
  const dates = dateRange(today(), NIGHTS);
  const end = dates[dates.length - 1];

  const [{ data: property }, { data: roomTypes }, { data: rules }, { data: plans }] = await Promise.all([
    supabase.from("properties").select("id, name").eq("id", propertyId).single(),
    supabase.from("room_types").select("id, name, count_of_rooms").eq("property_id", propertyId).order("sort"),
    supabase.from("pricing_rules").select("*"),
    supabase.from("rate_plans").select("id, room_type_id, ota_rate_plan_code"),
  ]);

  if (!property) {
    return <div className="card"><h2>Property not found</h2><p><Link href="/">Back</Link></p></div>;
  }

  const ruleOf = new Map((rules ?? []).map((r) => [r.room_type_id as string, r]));
  const planOf = new Map((plans ?? []).filter((p) => p.ota_rate_plan_code).map((p) => [p.room_type_id as string, p.id as string]));

  const { data: ari } = await supabase
    .from("ari")
    .select("room_type_id, rate_plan_id, date, availability, rate")
    .eq("property_id", propertyId)
    .gte("date", dates[0])
    .lte("date", end);

  const freeOn = new Map<string, number>();
  const priceOn = new Map<string, number>();
  for (const r of ari ?? []) {
    if (r.rate_plan_id === null) freeOn.set(`${r.room_type_id}|${r.date}`, r.availability ?? 0);
    else if (r.rate !== null) priceOn.set(`${r.rate_plan_id}|${r.date}`, Number(r.rate));
  }

  const { data: moves } = await supabase
    .from("pricing_log")
    .select("date, price, previous, factors, room_type_id, at")
    .eq("property_id", propertyId)
    .order("at", { ascending: false })
    .limit(MOVES);

  const nameOf = new Map((roomTypes ?? []).map((r) => [r.id as string, r.name as string]));
  const lastRun = moves?.[0]?.at ? new Date(moves[0].at as string) : null;

  return (
    <div className="stack">
      <div className="card">
        <h2>What pricing is doing</h2>
        <p className="legend">
          {property.name}. Prices are recalculated every hour for the next fortnight, hourly to ninety days,
          and overnight beyond that. Nothing moves more than five percent in one step.
          {lastRun ? ` Last change ${lastRun.toUTCString().replace("GMT", "UTC")}.` : " No changes recorded yet."}
        </p>
      </div>

      <div className="card">
        <h3>The fence</h3>
        <p className="legend">Below the floor it never sells, above the ceiling it never asks. Change these and the engine obeys immediately.</p>
        <table className="plain">
          <thead><tr><th>Room type</th><th>Units</th><th>Floor</th><th>Base</th><th>Ceiling</th><th>Max step</th></tr></thead>
          <tbody>
            {(roomTypes ?? []).map((rt) => {
              const r = ruleOf.get(rt.id as string);
              return (
                <tr key={rt.id as string}>
                  <td>{rt.name as string}</td>
                  <td className="num">{rt.count_of_rooms as number}</td>
                  <td className="num">{r ? `£${Math.round(Number(r.floor_rate))}` : "not set"}</td>
                  <td className="num">{r ? `£${Math.round(Number(r.base_rate))}` : "not set"}</td>
                  <td className="num">{r ? `£${Math.round(Number(r.ceiling_rate))}` : "not set"}</td>
                  <td className="num">{r ? `${Number(r.max_step_pct)}%` : "not set"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>The next {NIGHTS} nights</h3>
        <p className="legend">Price on top, units still free underneath. A zero means the room type is gone for that night.</p>
        <div className="scroller">
          <table className="plain grid">
            <thead>
              <tr>
                <th className="sticky">Room type</th>
                {dates.map((d) => (
                  <th key={d} className="num">{d.slice(8)}/{d.slice(5, 7)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(roomTypes ?? []).map((rt) => {
                const planId = planOf.get(rt.id as string);
                return (
                  <tr key={rt.id as string}>
                    <td className="sticky">{rt.name as string}</td>
                    {dates.map((d) => {
                      const price = planId ? priceOn.get(`${planId}|${d}`) : undefined;
                      const free = freeOn.get(`${rt.id}|${d}`) ?? 0;
                      return (
                        <td key={d} className={free === 0 ? "num gone" : "num"}>
                          <span className="price">{price ? `£${Math.round(price)}` : "—"}</span>
                          <span className="free">{free}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>What moved, and why</h3>
        <p className="legend">The last {MOVES} price changes, newest first.</p>
        <table className="plain">
          <thead><tr><th>Night</th><th>Room type</th><th>Was</th><th>Now</th><th>Heading for</th><th>Because</th></tr></thead>
          <tbody>
            {(moves ?? []).map((m, i) => {
              const f = m.factors as Factors;
              const up = m.previous !== null && Number(m.price) > Number(m.previous);
              return (
                <tr key={i}>
                  <td>{m.date as string}</td>
                  <td>{nameOf.get(m.room_type_id as string)}</td>
                  <td className="num">{m.previous === null ? "new" : `£${Math.round(Number(m.previous))}`}</td>
                  <td className={up ? "num up" : "num down"}>£{Math.round(Number(m.price))}</td>
                  <td className="num legend">£{f.target}</td>
                  <td>{why(f)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p><Link href="/">Back to properties</Link></p>
    </div>
  );
}
