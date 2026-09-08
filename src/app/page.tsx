import { redirect } from "next/navigation";
import { signedIn, authRequired } from "@/lib/session";
import Link from "next/link";
import { db } from "@/lib/db";
import type { Account, Property } from "@/lib/types";
import { health } from "@/lib/ops";

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
  let arrivals: { guest_name: string | null; arrival_date: string | null; forwarded_at: string | null; link_sent_at: string | null; status: string }[] = [];
  let open: { reason: string; message: string | null }[] = [];
  let switches: { key: string; value: string }[] = [];
  let roomTypeName = new Map<string, string>();

  try {
    const supabase = db();
    ops = await health();
    const [q, ch, mv, ar, es, sw, rt] = await Promise.all([
      supabase.from("outbox").select("id", { count: "exact", head: true }).is("sent_at", null),
      supabase.from("channels").select("ota_hotel_id, is_active, property_id"),
      supabase.from("pricing_log").select("date, price, previous, room_type_id").order("at", { ascending: false }).limit(8),
      supabase.from("inbound_bookings").select("guest_name, arrival_date, forwarded_at, link_sent_at, status").order("received_at", { ascending: false }).limit(8),
      supabase.from("escalations").select("reason, message").is("resolved_at", null).order("raised_at", { ascending: false }).limit(5),
      supabase.from("hub_config").select("key, value").order("key"),
      supabase.from("room_types").select("id, name"),
    ]);
    queued = q.count ?? 0;
    channels = (ch.data ?? []) as typeof channels;
    moves = (mv.data ?? []) as typeof moves;
    arrivals = (ar.data ?? []) as typeof arrivals;
    open = (es.data ?? []) as typeof open;
    switches = (sw.data ?? []) as typeof switches;
    roomTypeName = new Map(((rt.data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name]));
  } catch {
    // The properties table below still renders; this panel simply stays quiet.
  }

  const liveChannel = channels.find((c) => c.is_active);
  const readyChannel = channels.find((c) => !c.is_active && c.ota_hotel_id);

  return (
    <div className="stack">
      <h1>Channel hub</h1>

      {ops ? (
        <div className="card">
          <h2>
            {ops.healthy ? "Everything is running" : "Something needs looking at"}
          </h2>
          <p className="lede">
            {liveChannel
              ? `Selling live on Booking.com hotel ${liveChannel.ota_hotel_id}.`
              : readyChannel
                ? `Connected to Booking.com hotel ${readyChannel.ota_hotel_id} but switched off, so nothing reaches a guest yet.`
                : "No Booking.com channel yet."}
            {" "}
            {queued === 0 ? "Nothing waiting to go out." : `${queued} changes still on their way to Channex.`}
            {" "}
            {ops.closures === 0
              ? "No night is closed or capped."
              : `${ops.closures} nights are closed or capped, which nothing here ever does.`}
          </p>

          <table className="plain">
            <thead><tr><th>Job</th><th>Last good run</th><th>State</th></tr></thead>
            <tbody>
              {ops.jobs.map((j) => (
                <tr key={j.job}>
                  <td>{j.job}</td>
                  <td>{j.last_ok ? new Date(j.last_ok).toUTCString().replace("GMT", "UTC") : "never"}</td>
                  <td className={j.stale ? "down" : "up"}>{j.stale ? "stale" : "running"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="legend">
            Switches: {switches.map((s) => `${s.key.replace(/_/g, " ")} is ${s.value === "false" ? "OFF" : "on"}`).join(", ") || "none set"}.
            Machine readable at <code>/api/health</code>.
          </p>
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
          <p className="legend">None yet. The channel is switched off, so nothing has arrived.</p>
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
                    <td>
                      <Link href={`/grid/${p.id}`}>Open grid</Link>{" "}
                      <Link href={`/pricing/${p.id}`}>What pricing is doing</Link>
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
