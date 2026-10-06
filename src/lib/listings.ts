import { createClient } from "@supabase/supabase-js";
import { db } from "./db";
import { channexRequest } from "./channex";
import { connectBookingCom, provisionProperty } from "./provision";
import { syncAvailability } from "./parkside";
import { priceProperty } from "./pricing";
import { fullSync } from "./fullsync";

/**
 * Puts a new Booking.com listing on sale through Channex, start to finish.
 *
 * This is the sequence that put Victory Suites Studios with No Balcony live on
 * 6 October 2026, written down as code so it does not have to be rediscovered
 * each time. Everything a listing needs is a row: which apartments, how many
 * guests, the price fence. No deploy.
 *
 * What it does, in order, stopping at the first thing that would break a sale:
 *  1. Reads the listing from Booking.com through Channex, so the room and rate
 *     codes come from Booking.com rather than being typed in.
 *  2. Checks every apartment exists in the guest portal and sells nowhere else.
 *  3. Writes the property, room types, rate plans and price fence to the hub.
 *  4. Creates it all on Channex.
 *  5. Works out availability from the portal and prices from the engine.
 *  6. Connects Booking.com, switched off, and asks Channex what blocks it.
 *  7. If asked to go live: switches it on, sends a full sync, and then reads
 *     Booking.com's own answer. Channex accepting a call is not Booking.com
 *     accepting it; on 6 October Channex said success while Booking.com refused
 *     every price because the room was set to one guest. If Booking.com refuses,
 *     the channel is switched straight back off so nothing sells half set up.
 */

export type ListingRoomType = {
  name: string;
  apartments: string[];
  guests: number;
  floor: number;
  base: number;
  ceiling: number;
  /** Only needed when the Booking.com listing has more than one room. */
  bdc_room_code?: string;
};

export type ListingInput = {
  name: string;
  hotel_id: string;
  room_types: ListingRoomType[];
  activate?: boolean;
};

export type ListingStep = { step: string; ok: boolean; detail: string };
export type ListingResult = { property_id: string | null; channel_id: string | null; live: boolean; steps: ListingStep[] };

type BdcRate = { id: number | string; title: string; max_persons: number | null; parent_rate_id: string | number | null; readonly?: boolean };
type BdcRoom = { id: number | string; title: string; rates: BdcRate[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portalClient() {
  const url = process.env.PORTAL_SUPABASE_URL;
  const key = process.env.PORTAL_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("PORTAL_SUPABASE_URL and PORTAL_SERVICE_ROLE_KEY are not set");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function addListing(input: ListingInput): Promise<ListingResult> {
  const hub = db();
  const result: ListingResult = { property_id: null, channel_id: null, live: false, steps: [] };
  const say = (step: string, ok: boolean, detail: string) => result.steps.push({ step, ok, detail });
  const stop = (step: string, detail: string) => {
    say(step, false, detail);
    return result;
  };

  const hotelId = String(input.hotel_id ?? "").trim();
  if (!/^\d+$/.test(hotelId)) return stop("input", "hotel_id must be the Booking.com hotel number");
  if (!input.name?.trim()) return stop("input", "name is required");
  if (!input.room_types?.length) return stop("input", "at least one room type is required");
  for (const rt of input.room_types) {
    if (!rt.name?.trim() || !rt.apartments?.length) return stop("input", "every room type needs a name and apartments");
    if (!(rt.guests >= 1)) return stop("input", `${rt.name}: guests must be at least 1`);
    if (!(rt.floor > 0 && rt.floor <= rt.base && rt.base <= rt.ceiling)) {
      return stop("input", `${rt.name}: prices must run floor <= base <= ceiling, all above zero`);
    }
  }

  // Already ours? Then this is a repeat, not a new listing.
  const { data: existing } = await hub.from("channels").select("property_id").eq("ota_hotel_id", hotelId).maybeSingle();
  if (existing) return stop("input", `Hotel ${hotelId} is already set up in the hub (property ${existing.property_id})`);

  // 1. What Booking.com holds for this hotel.
  const mapping = await channexRequest<{ data?: { rooms?: BdcRoom[] } }>("POST", "/channels/mapping_details", {
    channel: "BookingCom",
    settings: { hotel_id: hotelId },
  });
  const bdcRooms = mapping.body?.data?.rooms ?? [];
  if (!mapping.ok || bdcRooms.length === 0) {
    return stop(
      "booking.com",
      `Could not read hotel ${hotelId} from Booking.com (${mapping.error ?? "no rooms"}). Approve Channex.io as the connectivity provider in the extranet first.`,
    );
  }
  if (input.room_types.length > 1 && input.room_types.some((rt) => !rt.bdc_room_code)) {
    return stop(
      "booking.com",
      `This listing has ${bdcRooms.length} Booking.com rooms; give each room type its bdc_room_code: ${bdcRooms.map((r) => `${r.id} "${r.title}"`).join(", ")}`,
    );
  }

  const codes: { roomCode: string; rateCode: string; maxPersons: number | null }[] = [];
  for (const rt of input.room_types) {
    const room = rt.bdc_room_code ? bdcRooms.find((r) => String(r.id) === String(rt.bdc_room_code)) : bdcRooms.length === 1 ? bdcRooms[0] : null;
    if (!room) return stop("booking.com", `${rt.name}: no Booking.com room ${rt.bdc_room_code ?? ""} on hotel ${hotelId}`);
    // The rate a channel manager prices is the parent one; derived rates follow it.
    const rate = room.rates.find((r) => !r.parent_rate_id && !r.readonly) ?? room.rates[0];
    if (!rate) return stop("booking.com", `${rt.name}: Booking.com room ${room.id} has no rate plan`);
    codes.push({ roomCode: String(room.id), rateCode: String(rate.id), maxPersons: rate.max_persons ?? null });
    if (rate.max_persons !== null && rate.max_persons < rt.guests) {
      // A warning, not a stop: what Channex reports here can lag the extranet by
      // a while after it is changed. Booking.com's answer in step 7 is the truth.
      say(
        "booking.com",
        true,
        `WARNING ${rt.name}: Booking.com reports rate ${rate.id} for ${rate.max_persons} guest(s), we price for ${rt.guests}. If prices are refused, set the room to ${rt.guests} guests in the extranet (room details AND pricing per guest).`,
      );
    }
  }
  say("booking.com", true, `Hotel ${hotelId}: ${codes.map((c) => `room ${c.roomCode} rate ${c.rateCode}`).join("; ")}`);

  // 2. The apartments are real and free to give.
  const wanted = input.room_types.flatMap((rt) => rt.apartments.map((a) => a.trim()));
  if (new Set(wanted).size !== wanted.length) return stop("apartments", "An apartment is listed twice");
  const { data: inPortal, error: portalError } = await portalClient().from("properties").select("room_number").in("room_number", wanted);
  if (portalError) return stop("apartments", `Guest portal: ${portalError.message}`);
  const missing = wanted.filter((a) => !(inPortal ?? []).some((p) => p.room_number === a));
  if (missing.length) return stop("apartments", `Not in the guest portal: ${missing.join(", ")}`);
  const { data: taken } = await hub.from("room_types").select("name, apartments").overlaps("apartments", wanted);
  if (taken?.length) {
    return stop("apartments", `Already selling elsewhere: ${taken.map((t) => `${(t.apartments as string[]).filter((a) => wanted.includes(a)).join(", ")} under ${t.name}`).join("; ")}`);
  }
  say("apartments", true, `${wanted.join(", ")} found in the portal and free to list`);

  // 3. The hub rows. Bookings go downstream exactly as the existing listings do.
  const { data: template } = await hub
    .from("properties")
    .select("account_id, downstream_url, downstream_secret")
    .eq("is_active", true)
    .not("channex_property_id", "is", null)
    .not("downstream_url", "is", null)
    .limit(1)
    .single();
  if (!template) return stop("hub", "No live property to copy the account and downstream settings from");

  const { data: property, error: propError } = await hub
    .from("properties")
    .insert({
      account_id: template.account_id,
      name: input.name.trim(),
      currency: "GBP",
      timezone: "Europe/Gibraltar",
      is_active: true,
      downstream_url: template.downstream_url,
      downstream_secret: template.downstream_secret,
    })
    .select("id")
    .single();
  if (propError || !property) return stop("hub", `Property: ${propError?.message}`);
  const propertyId = property.id as string;
  result.property_id = propertyId;

  for (const [i, rt] of input.room_types.entries()) {
    const { data: roomType, error: rtError } = await hub
      .from("room_types")
      .insert({
        property_id: propertyId,
        name: rt.name.trim(),
        count_of_rooms: rt.apartments.length,
        occ_adults: rt.guests,
        occ_children: 0,
        occ_infants: 0,
        default_occupancy: rt.guests,
        sort: i,
        apartments: rt.apartments.map((a) => a.trim()),
        ota_room_type_code: codes[i].roomCode,
      })
      .select("id")
      .single();
    if (rtError || !roomType) return stop("hub", `Room type ${rt.name}: ${rtError?.message}`);
    const { error: planError } = await hub.from("rate_plans").insert([
      { room_type_id: roomType.id, name: "Best Available Rate", occupancy: rt.guests, is_primary: true, ota_rate_plan_code: codes[i].rateCode },
      { room_type_id: roomType.id, name: "Non-Refundable", occupancy: rt.guests, is_primary: false, ota_rate_plan_code: null },
    ]);
    if (planError) return stop("hub", `Rate plans for ${rt.name}: ${planError.message}`);
    const { error: ruleError } = await hub.from("pricing_rules").insert({
      room_type_id: roomType.id,
      floor_rate: rt.floor,
      base_rate: rt.base,
      ceiling_rate: rt.ceiling,
      is_active: true,
      max_step_pct: 3,
    });
    if (ruleError) return stop("hub", `Price fence for ${rt.name}: ${ruleError.message}`);
  }
  say("hub", true, `Property ${propertyId} with ${input.room_types.length} room type(s)`);

  // 4. Channex.
  const provisioned = await provisionProperty(propertyId);
  const failed = provisioned.filter((s) => s.error || !s.id);
  if (failed.length) return stop("channex", failed.map((f) => `${f.entity} ${f.name}: ${f.error}`).join("; "));
  say("channex", true, provisioned.filter((s) => s.created).map((s) => `${s.entity} ${s.name}`).join(", ") || "already there");

  // 5. Availability from the portal, prices from the engine.
  const availability = await syncAvailability(propertyId);
  say("availability", true, `${availability.apartments} apartments, ${availability.bookings_held} bookings held, ${availability.rows_changed} nights written`);
  const pricing = await priceProperty(propertyId, "all");
  say("pricing", true, `${pricing.nights_considered} nights priced, average ${pricing.average ?? "n/a"} published`);

  // 6. Booking.com, switched off.
  const connected = await connectBookingCom(propertyId, hotelId);
  if (connected.error || !connected.channel_id) return stop("connect", connected.error ?? "No channel came back");
  result.channel_id = connected.channel_id;
  const blockers = (connected.readiness as { data?: unknown[] } | null)?.data ?? [];
  if (blockers.length) return stop("connect", `Channex says activation is blocked: ${JSON.stringify(blockers)}`);
  say("connect", true, `Channel ${connected.channel_id} created, switched off, nothing blocking`);

  if (!input.activate) {
    say("live", true, "Left switched off as asked. Run again with activate, or use goLive.");
    return result;
  }
  return goLive(propertyId, result);
}

/**
 * Switches a connected listing on and proves Booking.com took it. Separate so a
 * listing set up switched off can be put live later with the same checks.
 */
export async function goLive(propertyId: string, result?: ListingResult): Promise<ListingResult> {
  const hub = db();
  const out: ListingResult = result ?? { property_id: propertyId, channel_id: null, live: false, steps: [] };
  const say = (step: string, ok: boolean, detail: string) => out.steps.push({ step, ok, detail });

  const { data: channel } = await hub
    .from("channels")
    .select("channex_channel_id")
    .eq("property_id", propertyId)
    .eq("channel", "BookingCom")
    .maybeSingle();
  const channelId = (channel?.channex_channel_id as string | null) ?? null;
  if (!channelId) {
    say("live", false, "This property has no Booking.com channel yet");
    return out;
  }
  out.channel_id = channelId;

  const activated = await channexRequest("POST", `/channels/${channelId}/activate`);
  if (!activated.ok) {
    say("live", false, `Channex would not activate: ${activated.error}`);
    return out;
  }
  await hub.from("channels").update({ is_active: true }).eq("channex_channel_id", channelId);
  const startedAt = new Date().toISOString().slice(0, 19);

  const sync = await fullSync(propertyId, { force: true });
  say("full sync", !!(sync.availability?.ok && sync.restrictions?.ok), JSON.stringify({ availability: sync.availability?.ok, restrictions: sync.restrictions?.ok }));

  const verdict = await bookingComVerdict(channelId, startedAt);
  if (verdict.ok) {
    say("booking.com", true, "Booking.com accepted availability and prices");
    out.live = true;
    return out;
  }

  // Half set up is worse than off: availability without prices can still sell
  // at whatever is typed into the extranet.
  await channexRequest("POST", `/channels/${channelId}/deactivate`);
  await hub.from("channels").update({ is_active: false }).eq("channex_channel_id", channelId);
  say("booking.com", false, `Booking.com refused, channel switched back off: ${verdict.reason}`);
  return out;
}

/** Reads what Booking.com itself answered to the sync after `since`. */
export async function bookingComVerdict(channelId: string, since: string): Promise<{ ok: boolean; reason: string }> {
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(4000);
    const events = await channexRequest<{ data?: { id: string; attributes: { name: string; inserted_at: string; payload?: { result?: string } } }[] }>(
      "GET",
      `/channel_events?filter[channel_id]=${channelId}&pagination[limit]=50`,
    );
    const syncs = (events.body?.data ?? []).filter((e) => e.attributes.name === "sync" && e.attributes.inserted_at >= since);
    if (!syncs.length) continue;
    const latest = syncs[syncs.length - 1];
    if (latest.attributes.payload?.result === "success") return { ok: true, reason: "" };
    const logs = await channexRequest<{ data?: { logs?: { data?: { response?: string } }[] } }>("GET", `/channel_events/${latest.id}/logs`);
    const reasons = new Set<string>();
    for (const l of logs.body?.data?.logs ?? []) {
      for (const m of String(l.data?.response ?? "").matchAll(/ShortText="([^"]+)"/g)) reasons.add(m[1]);
    }
    return { ok: false, reason: [...reasons].join(" | ") || "Booking.com returned an error with no reason given" };
  }
  return { ok: false, reason: "No answer from Booking.com within a minute; check channel events in Channex" };
}
