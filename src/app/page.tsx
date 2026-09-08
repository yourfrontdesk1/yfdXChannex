import { redirect } from "next/navigation";
import { signedIn, authRequired } from "@/lib/session";
import Link from "next/link";
import { db } from "@/lib/db";
import type { Account, Property } from "@/lib/types";
import { health } from "@/lib/ops";
import NightsChart from "@/components/NightsChart";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (authRequired() && !(await signedIn())) redirect("/sign-in");

  let accounts: Account[] = [];
  let properties: Property[] = [];
  let error: string | null = null;

  try {
    const supabase = db();
    const [a, p] = await Promise.all([
      supabase.from("accounts").select("*").order("name"),
      supabase.from("properties").select("*").order("name"),
    ]);
    if (a.error) throw a.error;
    if (p.error) throw p.error;
    accounts = (a.data ?? []) as Account[];
    properties = (p.data ?? []) as Property[];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // The control room. One screen that answers is it working, is it selling, is
  // anyone waiting on us, rather than three URLs and a guess.
  let ops: Awaited<ReturnType<typeof health>> | null = null;
  let queued = 0;
  let channels: { ota_hotel_id: string | null; is_active: boolean; property_id: string }[] = [];
  let moves: { date: string; price: number; previous: number | null; room_type_id: string }[] = [];
  let arrivals: { guest_name: string | null; arrival_date: string | null; forwarded_at: string | null; link_sent_at: string | null; status: string; property_id: string; received_at: string }[] = [];
  let open: { reason: string; message: string | null }[] = [];
  let switches: { key: string; value: string }[] = [];
  let roomTypeName = new Map<string, string>();
  let nights: { date: string; units: number; sold: number; price: number | null }[] = [];

  try {
    const supabase = db();
    ops = await health();
    const [q, ch, mv, ar, es, sw, rt] = await Promise.all([
      supabase.from("outbox").select("id", { count: "exact", head: true }).is("sent_at", null),
      supabase.from("channels").select("ota_hotel_id, is_active, property_id"),
      supabase.from("pricing_log").select("date, price, previous, room_type_id").order("at", { ascending: false }).limit(8),
      supabase
        .from("inbound_bookings")
        .select("guest_name, arrival_date, forwarded_at, link_sent_at, status, property_id, received_at")
        .gte("received_at", "2026-09-08T21:00:00Z")
        .order("received_at", { ascending: false })
        .limit(40),
      supabase.from("escalations").select("reason, message").is("resolved_at", null).order("raised_at", { ascending: false }).limit(5),
      supabase.from("hub_config").select("key, value").order("key"),
      supabase.from("room_types").select("id, name, count_of_rooms, property_id"),
    ]);
    queued = q.count ?? 0;
    channels = (ch.data ?? []) as typeof channels;
    moves = (mv.data ?? []) as typeof moves;
    arrivals = (ar.data ?? []) as typeof arrivals;
    open = (es.data ?? []) as typeof open;
    switches = (sw.data ?? []) as typeof switches;
    roomTypeName = new Map(((rt.data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name]));

    // The next thirty nights for whichever property is actually selling.
    const sellingProperty = properties.find((prop) => prop.is_active && prop.channex_property_id);
    if (sellingProperty) {
      const types = ((rt.data ?? []) as { id: string; count_of_rooms: number; property_id: string }[])
        .filter((t) => t.property_id === sellingProperty.id);
      const totalUnits = types.reduce((sum, t) => sum + Number(t.count_of_rooms ?? 0), 0);
      const start = new Date().toISOString().slice(0, 10);
      const finish = new Date(Date.now() + 29 * 86400000).toISOString().slice(0, 10);

      const [{ data: avail }, { data: rates }] = await Promise.all([
        supabase.from("ari").select("date, availability").eq("property_id", sellingProperty.id).is("rate_plan_id", null).gte("date", start).lte("date", finish),
        supabase.from("ari").select("date, rate").eq("property_id", sellingProperty.id).not("rate_plan_id", "is", null).not("rate", "is", null).gte("date", start).lte("date", finish),
      ]);

      const freeByDate = new Map<string, number>();
      for (const r of avail ?? []) freeByDate.set(r.date as string, (freeByDate.get(r.date as string) ?? 0) + (r.availability ?? 0));
      const priceByDate = new Map<string, number[]>();
      for (const r of rates ?? []) {
        const key = r.date as string;
        priceByDate.set(key, [...(priceByDate.get(key) ?? []), Number(r.rate)]);
      }

      nights = Array.from({ length: 30 }, (_, i) => {
        const date = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
        const free = freeByDate.get(date) ?? 0;
        const list = priceByDate.get(date) ?? [];
        return {
          date,
          units: totalUnits,
          sold: Math.max(0, totalUnits - free),
          price: list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null,
        };
      });
    }
  } catch {
    // The properties table below still renders; this panel simply stays quiet.
  }

  // Only properties that can actually sell. A retired certification property
  // still has a channel row and old test bookings against it, and showing those
  // as "the latest" is worse than showing nothing.
  const liveIds = new Set(properties.filter((p) => p.is_active).map((p) => p.id));
  const liveChannels = channels.filter((c) => liveIds.has(c.property_id));
  const tonight = nights[0] ?? null;
  const occupancy = nights.length
    ? Math.round((nights.reduce((sum, n) => sum + n.sold, 0) / nights.reduce((sum, n) => sum + n.units, 0)) * 100)
    : 0;
  const pricedNights = nights.filter((n) => n.price !== null);
  const averagePrice = pricedNights.length
    ? Math.round(pricedNights.reduce((sum, n) => sum + (n.price ?? 0), 0) / pricedNights.length)
    : null;
  const soldOut = nights.filter((n) => n.units > 0 && n.sold >= n.units).length;

  const liveChannel = liveChannels.find((c) => c.is_active);
  const readyChannel = liveChannels.find((c) => !c.is_active && c.ota_hotel_id);
  arrivals = arrivals.filter((b) => liveIds.has(b.property_id as string)).slice(0, 8);

  return (
    <div className="stack">
      <h1>Channel hub</h1>

      {nights.length > 0 ? (
        <>
          <p className="lede">
            {liveChannel
              ? `Selling live on Booking.com hotel ${liveChannel.ota_hotel_id}.`
              : readyChannel
                ? `Connected to Booking.com hotel ${readyChannel.ota_hotel_id} and switched off, so nothing reaches a guest yet.`
                : "No Booking.com channel yet."}
          </p>

          <dl className="figures">
            <div>
              <dt>Tonight</dt>
              <dd>
                {tonight ? `${tonight.sold} of ${tonight.units}` : "unknown"}
                <small>{tonight ? `${tonight.units - tonight.sold} apartments free` : ""}</small>
              </dd>
            </div>
            <div>
              <dt>Next 30 nights</dt>
              <dd>
                {occupancy}%
                <small>occupied across {nights[0].units} apartments</small>
              </dd>
            </div>
            <div>
              <dt>Average ask</dt>
              <dd>
                £{averagePrice ?? 0}
                <small>across every room type</small>
              </dd>
            </div>
            <div>
              <dt>Sold out nights</dt>
              <dd>
                {soldOut}
                <small>of the next 30</small>
              </dd>
            </div>
          </dl>

          <div className="card">
            <h2>The next 30 nights</h2>
            <p className="legend">
              Apartments sold on top, gold where the building is full. The average ask underneath, on its own scale.
            </p>
            <NightsChart nights={nights} />
          </div>
        </>
      ) : null}

      {ops ? (
        <div className="card">
          <p className="statusline">
            <span className={ops.healthy ? "dot ok" : "dot bad"} />
            <strong>{ops.healthy ? "All nine jobs running" : "Something needs looking at"}</strong>
            <span className="legend">
              {queued === 0 ? "nothing waiting to go out" : `${queued} changes on their way to Channex`}
              {ops.closures === 0 ? ", no night wrongly closed" : `, ${ops.closures} nights wrongly closed`}
              {switches.some((s) => s.value === "false") ? `, ${switches.filter((s) => s.value === "false").map((s) => s.key.replace(/_/g, " ")).join(" and ")} OFF` : ""}
            </span>
          </p>

          {!ops.healthy ? (
            <table className="plain">
              <thead><tr><th>Job</th><th>Last good run</th><th>State</th></tr></thead>
              <tbody>
                {ops.jobs.filter((j) => j.stale).map((j) => (
                  <tr key={j.job}>
                    <td>{j.job}</td>
                    <td>{j.last_ok ? new Date(j.last_ok).toLocaleString("en-GB", { timeZone: "Europe/Gibraltar" }) : "never"}</td>
                    <td className="down">stale</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      {open.length > 0 ? (
        <div className="card">
          <h2>Waiting for a person</h2>
          <p className="legend">The assistant stopped rather than answer these.</p>
          <ul>
            {open.map((e, i) => (
              <li key={i}>{e.reason}: {((e.message ?? "") as string).slice(0, 140)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card">
        <h2>Latest bookings</h2>
        {arrivals.length === 0 ? (
          <p className="legend">None yet. The channel is switched off, so no reservation has arrived.</p>
        ) : (
          <table className="plain">
            <thead><tr><th>Guest</th><th>Arrives</th><th>Status</th><th>In the portal</th><th>Link sent</th></tr></thead>
            <tbody>
              {arrivals.map((b, i) => (
                <tr key={i}>
                  <td>{b.guest_name ?? "unnamed"}</td>
                  <td>{b.arrival_date ?? ""}</td>
                  <td>{b.status}</td>
                  <td className={b.forwarded_at ? "up" : "down"}>{b.forwarded_at ? "yes" : "not yet"}</td>
                  <td className={b.link_sent_at ? "up" : "down"}>{b.link_sent_at ? "yes" : "not yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Latest price moves</h2>
        {moves.length === 0 ? (
          <p className="legend">Nothing yet.</p>
        ) : (
          <table className="plain">
            <thead><tr><th>Night</th><th>Room type</th><th>Was</th><th>Now</th></tr></thead>
            <tbody>
              {moves.map((m, i) => (
                <tr key={i}>
                  <td>{m.date}</td>
                  <td>{roomTypeName.get(m.room_type_id) ?? ""}</td>
                  <td className="num">{m.previous === null ? "new" : `£${Math.round(Number(m.previous))}`}</td>
                  <td className={m.previous !== null && Number(m.price) > Number(m.previous) ? "num up" : "num down"}>
                    £{Math.round(Number(m.price))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Properties</h2>

      {error ? (
        <div className="card">
          <h2>Not connected to the database yet</h2>
          <p className="lede">
            Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then run the schema in
            db/001_schema.sql.
          </p>
          <p className="legend">{error}</p>
        </div>
      ) : properties.length === 0 ? (
        <div className="card">
          <h2>No properties yet</h2>
          <p className="lede">
            Seed an account and its property, then the grid opens on it.
          </p>
        </div>
      ) : (
        <div className="card">
          <table className="list">
            <thead>
              <tr>
                <th>Property</th>
                <th>Account</th>
                <th>Currency</th>
                <th>Channex</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {properties.map((p) => {
                const account = accounts.find((a) => a.id === p.account_id);
                return (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{account ? account.name : "unassigned"}</td>
                    <td>{p.currency}</td>
                    <td>
                      {p.channex_property_id ? (
                        <span className="pill live">mapped</span>
                      ) : (
                        <span className="pill pending">not mapped</span>
                      )}
                    </td>
                    <td className="actions">
                      <Link href={`/grid/${p.id}`}>Rate grid</Link>
                      <Link href={`/pricing/${p.id}`}>Pricing</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
