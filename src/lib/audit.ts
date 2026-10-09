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
    .select("property_id, ota_hotel_id, channex_channel_id, is_active, properties!inner(name, channex_property_id, is_active)")
    .eq("is_active", true)
    .eq("properties.is_active", true);

  const hooks = await channexRequest<{ data?: { attributes: { event_mask: string }; relationships?: { property?: { data?: { id?: string } } } }[] }>(
    "GET",
    "/webhooks?pagination[limit]=100",
  );

  for (const c of channels ?? []) {
    const prop = c.properties as unknown as { name: string; channex_property_id: string };
    const name = `${prop.name} (${c.ota_hotel_id})`;
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
    add("booking.com accepted last sync", last?.attributes.payload?.result === "success", last ? `${last.attributes.inserted_at.slice(0, 16)} ${last.attributes.payload?.result}` : "no sync yet");

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
    let off = 0;
    const examples: string[] = [];
    for (const row of ari ?? []) {
      if (row.rate_plan_id === null) {
        const rt = (rts ?? []).find((r) => r.id === row.room_type_id);
        const theirs = avail.body?.data?.[rt?.channex_room_type_id as string]?.[row.date as string];
        if (theirs !== row.availability) { off++; if (examples.length < 3) examples.push(`${row.date} free ${row.availability} vs ${theirs}`); }
      } else {
        const plan = (plans ?? []).find((p) => p.id === row.rate_plan_id);
        if (!plan) continue;
        const theirs = rates.body?.data?.[plan.channex_rate_plan_id as string]?.[row.date as string]?.rate;
        if (row.rate !== null && Number(theirs) !== Number(row.rate)) { off++; if (examples.length < 3) examples.push(`${row.date} £${row.rate} vs £${theirs}`); }
      }
    }
    add("channex matches hub, 30 nights", off === 0, off ? `${off} differ: ${examples.join("; ")}` : "identical");

    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: stuck } = await hub
      .from("inbound_bookings")
      .select("ota_reservation_code, forward_error")
      .eq("property_id", c.property_id)
      .gte("received_at", since)
      .is("forwarded_at", null);
    add("bookings reached YourFrontDesk", !(stuck ?? []).length, (stuck ?? []).length ? `${stuck!.length} not forwarded: ${stuck!.map((s) => s.ota_reservation_code).join(", ")}` : "none stuck in 7 days");

    // Every guest gets their portal link, every time. A new booking arriving in
    // the next 60 days with no link after 15 minutes means a guest who cannot
    // check in. Bookings further out are left alone on purpose: a link for a
    // stay next summer was not wanted (Leon, 6 October 2026).
    const soon = iso(new Date(Date.now() + 60 * 86400000));
    const settled = new Date(Date.now() - 15 * 60000).toISOString();
    const { data: unlinked } = await hub
      .from("inbound_bookings")
      .select("ota_reservation_code, guest_name, arrival_date, status")
      .eq("property_id", c.property_id)
      .eq("status", "new")
      .is("link_sent_at", null)
      .gte("arrival_date", iso(new Date()))
      .lte("arrival_date", soon)
      .lte("received_at", settled);
    const cancelledCodes = new Set(
      ((await hub.from("inbound_bookings").select("ota_reservation_code").eq("property_id", c.property_id).eq("status", "cancelled")).data ?? []).map((r) => r.ota_reservation_code),
    );
    const missing = (unlinked ?? []).filter((b) => !cancelledCodes.has(b.ota_reservation_code));
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
