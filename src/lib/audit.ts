import { db } from "./db";
import { channexRequest } from "./channex";

/**
 * Checks every live listing end to end, against the real systems rather than
 * against what the hub believes. Written after 6 October, when a listing went
 * live with Booking.com refusing its prices and Channex sending its bookings and
 * guest messages to nobody, and both were found by looking rather than by being
 * told. A failing check fails the job, so it turns the health board red.
 *
 * Per active Booking.com channel:
 *  - the channel is switched on in Channex
 *  - the property has a booking webhook and a message webhook, and the Messages app
 *  - Booking.com's own answer to the latest sync was success
 *  - Channex holds the same availability and price as the hub for 30 nights
 *  - no booking in the last 7 days failed to reach YourFrontDesk
 *  - every guest arriving in the next 60 days has been sent their portal link
 */

export type AuditCheck = { property: string; check: string; ok: boolean; detail: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function auditListings(): Promise<{ checks: AuditCheck[]; failed: number }> {
  const hub = db();
  const checks: AuditCheck[] = [];

  const { data: channels } = await hub
    .from("channels")
    .select("property_id, channel, ota_hotel_id, channex_channel_id, is_active, properties!inner(name, channex_property_id, is_active)")
    .eq("is_active", true)
    .eq("properties.is_active", true);

  const hooks = await channexRequest<{ data?: { attributes: { event_mask: string }; relationships?: { property?: { data?: { id?: string } } } }[] }>(
    "GET",
    "/webhooks?pagination[limit]=100",
  );

  for (const c of channels ?? []) {
    const prop = c.properties as unknown as { name: string; channex_property_id: string };
    // Label by the real channel (and its hotel id where there is one). Airbnb
    // has no hotel id, so it read "Victory Suites (null)" before.
    const name = `${prop.name} (${c.ota_hotel_id ?? c.channel})`;
    const add = (check: string, ok: boolean, detail: string) => checks.push({ property: name, check, ok, detail });

    const channel = await channexRequest<{ data?: { attributes?: { is_active?: boolean } } }>("GET", `/channels/${c.channex_channel_id}`);
    add("channel on", channel.body?.data?.attributes?.is_active === true, channel.ok ? `Channex says ${channel.body?.data?.attributes?.is_active ? "on" : "OFF"}` : `${channel.error}`);

    const masks = (hooks.body?.data ?? []).filter((w) => w.relationships?.property?.data?.id === prop.channex_property_id).map((w) => w.attributes.event_mask);
    const hasBooking = masks.some((m) => m.includes("booking_new"));
    const hasMessage = masks.some((m) => m.includes("message"));
    add("webhooks", hasBooking && hasMessage, `booking ${hasBooking ? "yes" : "MISSING"}, messages ${hasMessage ? "yes" : "MISSING"}`);

    const apps = await channexRequest<{ data?: { attributes: { property_id: string; application_code: string } }[] }>("GET", "/applications/installed");
    const hasMessages = (apps.body?.data ?? []).some((a) => a.attributes.property_id === prop.channex_property_id && a.attributes.application_code === "channex_messages");
    add("messages app", hasMessages, hasMessages ? "installed" : "MISSING, guests cannot be messaged");

    const events = await channexRequest<{ data?: { attributes: { name: string; inserted_at: string; payload?: { result?: string } } }[]; meta?: { total?: number } }>(
      "GET",
      `/channel_events?filter[channel_id]=${c.channex_channel_id}&pagination[limit]=100&order[inserted_at]=desc`,
    );
    const syncs = (events.body?.data ?? []).filter((e) => e.attributes.name === "sync").sort((a, b) => a.attributes.inserted_at.localeCompare(b.attributes.inserted_at));
    const last = syncs[syncs.length - 1];
    add(`${c.channel} accepted last sync`, last?.attributes.payload?.result === "success", last ? `${last.attributes.inserted_at.slice(0, 16)} ${last.attributes.payload?.result}` : "no sync yet");

    // Availability and the selling price, hub against Channex, next 30 nights.
    const from = iso(new Date());
    const to = iso(new Date(Date.now() + 29 * 86400000));
    const { data: rts } = await hub.from("room_types").select("id, channex_room_type_id").eq("property_id", c.property_id);
    const { data: plans } = await hub
      .from("rate_plans")
      .select("id, channex_rate_plan_id")
      .in("room_type_id", (rts ?? []).map((r) => r.id))
      .not("ota_rate_plan_code", "is", null);
    const { data: ari } = await hub
      .from("ari")
      .select("room_type_id, rate_plan_id, date, availability, rate")
      .eq("property_id", c.property_id)
      .gte("date", from)
      .lte("date", to);
    const avail = await channexRequest<{ data?: Record<string, Record<string, number>> }>(
      "GET",
      `/availability?filter[property_id]=${prop.channex_property_id}&filter[date][gte]=${from}&filter[date][lte]=${to}`,
    );
    const rates = await channexRequest<{ data?: Record<string, Record<string, { rate: string }>> }>(
      "GET",
      `/restrictions?filter[property_id]=${prop.channex_property_id}&filter[date][gte]=${from}&filter[date][lte]=${to}&filter[restrictions]=rate`,
    );
    // Availability: the hub pushes every minute and the audit takes one
    // snapshot, so a handful of nights are always mid-push; and Channex LOWER
    // than the hub is a lost sale, not a danger. Only Channex HIGHER (an
    // oversell) matters, and only when it lasts: we flag a night only when
    // Channex was higher on this run AND on the previous one. One hub_config
    // row per channel holds the previous run's oversell set.
    const oversell: string[] = [];
    const rateDrift: string[] = [];
    const rateEg = new Map<string, string>();
    for (const row of ari ?? []) {
      if (row.rate_plan_id === null) {
        const rt = (rts ?? []).find((r) => r.id === row.room_type_id);
        const theirs = avail.body?.data?.[rt?.channex_room_type_id as string]?.[row.date as string];
        if (typeof theirs === "number" && row.availability !== null && theirs > row.availability) {
          oversell.push(`${rt?.channex_room_type_id}|${row.date}`);
        }
      } else {
        const plan = (plans ?? []).find((p) => p.id === row.rate_plan_id);
        if (!plan) continue;
        const theirs = rates.body?.data?.[plan.channex_rate_plan_id as string]?.[row.date as string]?.rate;
        if (row.rate !== null && Number(theirs) !== Number(row.rate)) {
          const k = `${plan.channex_rate_plan_id}|${row.date}`;
          rateDrift.push(k);
          if (rateEg.size < 3) rateEg.set(k, `${row.date} £${row.rate} vs £${theirs}`);
        }
      }
    }
    const osKey = `audit_oversell_${c.channex_channel_id}`;
    const { data: prevRow } = await hub.from("hub_config").select("value").eq("key", osKey).maybeSingle();
    let prevOversell: string[] = [];
    try { prevOversell = JSON.parse((prevRow?.value as string) ?? "[]"); } catch { prevOversell = []; }
    const prevSet = new Set(prevOversell);
    const persistent = oversell.filter((o) => prevSet.has(o));
    await hub.from("hub_config").upsert({ key: osKey, value: JSON.stringify(oversell) }, { onConflict: "key" });
    add(
      "no persistent oversell, 30 nights",
      persistent.length === 0,
      persistent.length
        ? `${persistent.length} night(s) Channex over hub across 2 runs: ${persistent.slice(0, 3).map((p) => p.split("|")[1]).join(", ")}`
        : oversell.length ? `${oversell.length} in-flight this run, none persistent` : "no oversell",
    );
    // Rate drift pushes with the same per-minute latency, so it gets the same
    // rule as availability: a wrong price only fails the board when the same
    // room and date is still wrong on the next run. A persistently wrong price
    // is wrong prices on sale, which is exactly what should be caught.
    const rdKey = `audit_ratedrift_${c.channex_channel_id}`;
    const { data: prevRdRow } = await hub.from("hub_config").select("value").eq("key", rdKey).maybeSingle();
    let prevRd: string[] = [];
    try { prevRd = JSON.parse((prevRdRow?.value as string) ?? "[]"); } catch { prevRd = []; }
    const prevRdSet = new Set(prevRd);
    const persistentRd = rateDrift.filter((r) => prevRdSet.has(r));
    await hub.from("hub_config").upsert({ key: rdKey, value: JSON.stringify(rateDrift) }, { onConflict: "key" });
    add(
      "channex rate matches hub, 30 nights",
      persistentRd.length === 0,
      persistentRd.length
        ? `${persistentRd.length} price(s) wrong across 2 runs: ${persistentRd.slice(0, 3).map((k) => rateEg.get(k) ?? k.split("|")[1]).join("; ")}`
        : rateDrift.length ? `${rateDrift.length} in-flight this run, none persistent` : "identical",
    );

    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: stuck } = await hub
      .from("inbound_bookings")
      .select("ota_reservation_code, forward_error")
      .eq("property_id", c.property_id)
      .gte("received_at", since)
      .is("forwarded_at", null);
    add("bookings reached YourFrontDesk", !(stuck ?? []).length, (stuck ?? []).length ? `${stuck!.length} not forwarded: ${stuck!.map((s) => s.ota_reservation_code).join(", ")}` : "none stuck in 7 days");

    // Every guest arriving in the next 60 days should have their portal link.
    // Judge each booking by its LATEST revision, and count it linked if ANY of
    // its revisions carries a link time (the portal may have sent it before the
    // switch). Skip superseded revisions, cancelled bookings, and bookings with
    // no apartment (unplaced Eclipse rows and do-not-contact guests are not
    // awaiting a link). Test and inactive properties are already excluded by the
    // active-channel loop. Bookings further out are left alone on purpose: a link
    // for a stay next summer was not wanted (Leon, 6 October 2026).
    const soon = iso(new Date(Date.now() + 60 * 86400000));
    const settled = new Date(Date.now() - 15 * 60000).toISOString();
    const { data: rows } = await hub
      .from("inbound_bookings")
      .select("ota_reservation_code, guest_name, arrival_date, status, apartment, link_sent_at, received_at")
      .eq("property_id", c.property_id)
      .gte("arrival_date", iso(new Date()))
      .lte("arrival_date", soon)
      .lte("received_at", settled)
      .order("received_at", { ascending: true });
    const latest = new Map<string, { guest_name: string; arrival_date: string; status: string; apartment: string | null }>();
    const linkedAny = new Set<string>();
    for (const r of rows ?? []) {
      const code = r.ota_reservation_code as string;
      latest.set(code, { guest_name: r.guest_name as string, arrival_date: r.arrival_date as string, status: String(r.status), apartment: (r.apartment as string | null) ?? null });
      if (r.link_sent_at) linkedAny.add(code);
    }
    const missing = [...latest.entries()]
      .filter(([code, b]) => b.status !== "cancelled" && b.apartment && !linkedAny.has(code))
      .map(([, b]) => b);
    add("every guest got their link", missing.length === 0, missing.length ? `${missing.length} without: ${missing.map((b) => `${b.guest_name} (${b.arrival_date})`).join(", ")}` : "all sent");
  }

  // Every guest answered. A message nobody has processed after ten minutes is a
  // guest waiting on nothing; a hand over left for two hours is a guest waiting
  // on a person. Leon, 9 October: "why are we not replying to all guest messages".
  const tenMin = new Date(Date.now() - 10 * 60000).toISOString();
  const twoHours = new Date(Date.now() - 2 * 3600000).toISOString();
  const { data: waiting } = await hub
    .from("guest_messages")
    .select("id, body")
    .eq("direction", "inbound")
    .is("forwarded_at", null)
    .lt("received_at", tenMin);
  checks.push({
    property: "All listings",
    check: "every guest message processed",
    ok: !(waiting ?? []).length,
    detail: (waiting ?? []).length ? `${waiting!.length} waiting over 10 minutes: "${String(waiting![0].body ?? "").slice(0, 60)}"` : "none waiting",
  });
  const { data: handed } = await hub.from("escalations").select("id, message").is("resolved_at", null).lt("raised_at", twoHours);
  checks.push({
    property: "All listings",
    check: "no guest left with a person",
    ok: !(handed ?? []).length,
    detail: (handed ?? []).length ? `${handed!.length} handed over more than 2 hours ago and not resolved: "${String(handed![0].message ?? "").slice(0, 60)}". Answer it on the Replies page.` : "none open",
  });

  // The reply engine needs the Anthropic account to have credit. On 7 October it
  // ran out and every guest message went to a person; found only when a guest
  // said thank you. A five token call says whether it can answer at all.
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "ok" }] }),
    }).catch(() => null);
    const text = res && !res.ok ? await res.text().catch(() => "") : "";
    checks.push({
      property: "All listings",
      check: "AI replies working",
      ok: !!res?.ok,
      detail: res?.ok ? "Anthropic answering" : /credit balance is too low/i.test(text) ? "OUT OF CREDIT, top up at console.anthropic.com" : `Anthropic ${res?.status ?? "unreachable"}`,
    });
  }

  return { checks, failed: checks.filter((c) => !c.ok).length };
}
