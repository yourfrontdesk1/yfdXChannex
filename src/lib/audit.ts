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
 *  - the property has a booking webhook and a message webhook
 *  - Booking.com's own answer to the latest sync was success
 *  - Channex holds the same availability and price as the hub for 30 nights
 *  - no booking in the last 7 days failed to reach YourFrontDesk
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
  }

  return { checks, failed: checks.filter((c) => !c.ok).length };
}
