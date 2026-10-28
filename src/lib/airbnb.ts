import { db } from "./db";
import { channexRequest } from "./channex";
import type { Property, RatePlan, RoomType } from "./types";
import { AIRBNB_LISTING_MAP, findAirbnbEntry, normaliseTitle } from "./airbnb-listings";

/**
 * Connect the main Victory Suites property to Airbnb through Channex.
 *
 * This is the sibling of connectBookingCom in provision.ts. It follows the same
 * shape (read the OTA's own rooms, build rate_plan mappings from the hub rows,
 * POST /channels created inactive, then check_readiness) with two differences
 * that matter:
 *
 *  1. Airbnb connects by OAuth, not a hotel_id. Leon performs a one-time
 *     authorisation in the browser; the link Channex gives back expires in about
 *     two hours. So the connect is in two steps:
 *       beginAirbnbOAuth(propertyId)    -> records the connection, returns the
 *                                          OAuth link for Leon to click.
 *       completeAirbnbMapping(propertyId) -> once authorised, reads the Airbnb
 *                                          listings and maps each to its hub
 *                                          room type, channel created inactive.
 *     connectAirbnb(propertyId, { step }) picks between them.
 *
 *  2. Each Airbnb listing sells ALL the apartments of its room type and gets the
 *     room type's REAL availability, exactly like Booking.com (owner, 28 Oct
 *     2026). There is deliberately NO max_availability / channel_availability_rule
 *     cap of 1. See airbnb-listings.ts.
 *
 * ---------------------------------------------------------------------------
 * TODO (needs confirming against the Channex Airbnb docs or a staging test):
 *   - CHANNEL_TYPE: the exact Channex channel-type string for Airbnb.
 *   - AIRBNB_OAUTH_PATH / the OAuth request + response shape.
 *   - airbnbMappingSettings(): the exact per-rate-plan settings key(s) Channex
 *     wants for an Airbnb listing mapping (listing_id vs room_id vs ...).
 *   - the connection reference Channex needs on mapping_details / POST /channels
 *     to identify the OAuth'd Airbnb account.
 * None of these are guessed-and-shipped: each is a single clearly-marked
 * constant/helper so the value is changed in one place once confirmed. The
 * parsing below is deliberately defensive about where in the envelope the pieces
 * land, because that too is unconfirmed.
 * ---------------------------------------------------------------------------
 */

// TODO confirm: Channex's channel-type string for Airbnb. Booking.com is
// "BookingCom"; Airbnb is believed to be "AirBNB". Do not treat as confirmed.
export const CHANNEL_TYPE = "AirBNB";

// TODO confirm: the endpoint that returns the Airbnb OAuth authorisation URL.
const AIRBNB_OAUTH_PATH = "/channels/oauth";

/** The channels table value. The row is the record of the connection. */
const CHANNEL_ROW = "Airbnb";

/**
 * The per-rate-plan settings for one Airbnb listing mapping.
 * TODO confirm the exact key Channex expects (listing_id is the best guess).
 * No availability cap is added here on purpose: the listing sells the room
 * type's real availability.
 */
export function airbnbMappingSettings(airbnbListingId: string): Record<string, unknown> {
  return {
    // TODO confirm key name against Channex Airbnb docs.
    listing_id: airbnbListingId,
  };
}

export type AirbnbListing = { id: string; title: string };

export type AirbnbRatePlanMapping = {
  room_type_name: string;
  bdc_room_code: string | null;
  airbnb_listing_title: string;
  /** Resolved from Channex once OAuth is done; null when planned pre-connect. */
  airbnb_listing_id: string | null;
  rate_plan_id: string;
  settings: Record<string, unknown>;
};

export type AirbnbMappingBuild = {
  mappings: AirbnbRatePlanMapping[];
  /** Room types left out on purpose (disabled in LH, or not on Airbnb at all). */
  skipped: { room_type: string; reason: string }[];
  /** Room types that should map but have no usable rate plan on the hub. */
  unmapped: { room_type: string; reason: string }[];
  /** Listings in the map that OAuth did not return by title (need the listing id). */
  unmatched: string[];
};

type HubRoomType = RoomType & { ota_room_type_code: string | null };
type HubRatePlan = RatePlan & { ota_rate_plan_code?: string | null };

/**
 * Pure. Given the hub's room types and rate plans, plus the Airbnb listings
 * Channex returned after OAuth, produce the rate_plan mappings for POST /channels.
 *
 * Testable without a database or a network call: pass the rows in, read the
 * mappings out. When `airbnbListings` is empty (before OAuth) it still builds
 * the intended pairings with airbnb_listing_id = null, so the plan can be shown
 * and checked before Leon clicks the link.
 */
export function buildAirbnbRatePlanMappings(
  roomTypes: HubRoomType[],
  ratePlans: HubRatePlan[],
  airbnbListings: AirbnbListing[],
): AirbnbMappingBuild {
  const out: AirbnbMappingBuild = { mappings: [], skipped: [], unmapped: [], unmatched: [] };

  const listingByTitle = new Map(airbnbListings.map((l) => [normaliseTitle(l.title), l]));
  const haveOAuthListings = airbnbListings.length > 0;
  const usedTitles = new Set<string>();

  for (const rt of roomTypes) {
    const entry = findAirbnbEntry(rt);
    if (!entry) {
      // Not on Airbnb (e.g. the jacuzzi room, or the dead "Studio Apartment").
      out.skipped.push({ room_type: rt.name, reason: "no Airbnb listing in the map" });
      continue;
    }
    if (entry.disabled) {
      // "1 bed" is switched off in LH's Airbnb mapping.
      out.skipped.push({ room_type: rt.name, reason: "disabled channel rate in LH" });
      continue;
    }

    // Flexible plan only: the primary rate plan carries the listing. Mirrors how
    // LH maps one Airbnb listing to the flexible rate.
    const plans = ratePlans.filter((p) => p.room_type_id === rt.id && p.channex_rate_plan_id);
    const plan = plans.find((p) => p.is_primary) ?? plans[0];
    if (!plan?.channex_rate_plan_id) {
      out.unmapped.push({ room_type: rt.name, reason: "no provisioned rate plan to carry the listing" });
      continue;
    }

    const key = normaliseTitle(entry.airbnbListingTitle);
    const listing = listingByTitle.get(key) ?? null;
    if (haveOAuthListings && !listing) {
      // OAuth is done but this title was not among the returned listings.
      out.unmatched.push(entry.airbnbListingTitle);
    }
    if (listing) usedTitles.add(key);

    out.mappings.push({
      room_type_name: rt.name,
      bdc_room_code: rt.ota_room_type_code ?? null,
      airbnb_listing_title: entry.airbnbListingTitle,
      airbnb_listing_id: listing?.id ?? null,
      rate_plan_id: plan.channex_rate_plan_id,
      settings: airbnbMappingSettings(listing?.id ?? ""),
    });
  }

  // Any mapped-and-enabled listing in the file that no hub room type claimed.
  if (haveOAuthListings) {
    for (const e of AIRBNB_LISTING_MAP) {
      if (e.disabled) continue;
      const key = normaliseTitle(e.airbnbListingTitle);
      if (!usedTitles.has(key) && !out.unmatched.includes(e.airbnbListingTitle)) {
        // Returned by OAuth but no hub room type mapped to it, or not returned at
        // all. Either way it is worth surfacing.
        if (!listingByTitle.has(key)) out.unmatched.push(e.airbnbListingTitle);
      }
    }
  }

  return out;
}

export type AirbnbConnectResult = {
  step: "begin" | "map";
  oauth_url: string | null;
  oauth_expires_hint: string | null;
  channel_id: string | null;
  listings_seen: AirbnbListing[];
  mapped: number;
  skipped: { room_type: string; reason: string }[];
  unmapped: { room_type: string; reason: string }[];
  unmatched: string[];
  readiness: unknown;
  error: string | null;
};

function emptyResult(step: "begin" | "map"): AirbnbConnectResult {
  return {
    step,
    oauth_url: null,
    oauth_expires_hint: null,
    channel_id: null,
    listings_seen: [],
    mapped: 0,
    skipped: [],
    unmapped: [],
    unmatched: [],
    readiness: null,
    error: null,
  };
}

async function propertyAndGroup(propertyId: string): Promise<
  { channexPropertyId: string; groupId: string; property: Property } | { error: string }
> {
  const supabase = db();
  const { data: propertyRow } = await supabase.from("properties").select("*").eq("id", propertyId).single();
  const property = propertyRow as Property | null;
  if (!property?.channex_property_id) return { error: "Provision the property on Channex first" };
  const { data: accountRow } = await supabase
    .from("accounts")
    .select("channex_group_id")
    .eq("id", property.account_id)
    .single();
  const groupId = accountRow?.channex_group_id as string | null;
  if (!groupId) return { error: "The account has no Channex group" };
  return { channexPropertyId: property.channex_property_id, groupId, property };
}

/**
 * Step 1. Record the Airbnb connection and get the OAuth authorisation link for
 * Leon to open. The link expires in about two hours, so step 2 has to follow
 * soon after he authorises.
 */
export async function beginAirbnbOAuth(propertyId: string): Promise<AirbnbConnectResult> {
  const result = emptyResult("begin");
  const ctx = await propertyAndGroup(propertyId);
  if ("error" in ctx) {
    result.error = ctx.error;
    return result;
  }

  // Record the connection as a channel row, created inactive, before we have a
  // channel id. Like BookingCom, Airbnb is never created active.
  await db()
    .from("channels")
    .upsert(
      { property_id: propertyId, channel: CHANNEL_ROW, ota_hotel_id: null, is_active: false },
      { onConflict: "property_id,channel" },
    );

  // TODO confirm the request shape. Channex returns an OAuth authorisation URL
  // that Leon opens to grant access to the Airbnb account. The response field is
  // parsed defensively because its exact location is unconfirmed.
  const res = await channexRequest<Record<string, unknown>>("POST", AIRBNB_OAUTH_PATH, {
    channel: CHANNEL_TYPE,
    group_id: ctx.groupId,
    property_id: ctx.channexPropertyId,
  });

  result.oauth_url = extractOAuthUrl(res.body);
  result.oauth_expires_hint = "about 2 hours";
  if (!res.ok) {
    result.error =
      `Could not start the Airbnb OAuth flow (${res.error}). ` +
      `The OAuth endpoint and request shape are a TODO: confirm against the Channex Airbnb docs.`;
  } else if (!result.oauth_url) {
    result.error =
      "Channex accepted the request but no OAuth URL was found in the response; the response shape is a TODO.";
  }
  return result;
}

/**
 * Step 2. After Leon authorises, read the Airbnb listings, map each to its hub
 * room type, and create the channel inactive. Safe to run more than once: it
 * upserts the channel row and asks Channex what still blocks activation.
 */
export async function completeAirbnbMapping(propertyId: string): Promise<AirbnbConnectResult> {
  const result = emptyResult("map");
  const supabase = db();
  const ctx = await propertyAndGroup(propertyId);
  if ("error" in ctx) {
    result.error = ctx.error;
    return result;
  }

  // The Airbnb listings Channex can see for the OAuth'd account. Same endpoint
  // as Booking.com's mapping read; the settings that identify the connection are
  // a TODO.
  const mapping = await channexRequest<{ data?: unknown }>("POST", "/channels/mapping_details", {
    channel: CHANNEL_TYPE,
    // TODO confirm what identifies the OAuth connection here (likely the channel
    // id from step 1, or an oauth token/account id Channex returned).
    settings: {},
  });
  const listings = extractAirbnbListings(mapping.body);
  result.listings_seen = listings;
  if (!mapping.ok) {
    result.error =
      `Could not read Airbnb listings (${mapping.error}). Has the OAuth link been authorised, and not expired? ` +
      `The mapping_details request shape for Airbnb is a TODO.`;
    return result;
  }

  const { data: roomTypeRows } = await supabase.from("room_types").select("*").eq("property_id", propertyId);
  const roomTypes = (roomTypeRows ?? []) as HubRoomType[];
  const { data: ratePlanRows } = roomTypes.length
    ? await supabase.from("rate_plans").select("*").in("room_type_id", roomTypes.map((r) => r.id))
    : { data: [] };
  const ratePlans = (ratePlanRows ?? []) as HubRatePlan[];

  const build = buildAirbnbRatePlanMappings(roomTypes, ratePlans, listings);
  result.mapped = build.mappings.length;
  result.skipped = build.skipped;
  result.unmapped = build.unmapped;
  result.unmatched = build.unmatched;

  if (build.mappings.length === 0) {
    result.error = "No hub room type could be mapped to an Airbnb listing yet";
    return result;
  }

  // Create the channel, inactive. Channex creates all channels inactive whatever
  // we pass; activation is a separate, deliberate step done later by Leon.
  const created = await channexRequest<{ data?: { id?: string } }>("POST", "/channels", {
    channel: {
      channel: CHANNEL_TYPE,
      group_id: ctx.groupId,
      title: `${ctx.property.name} (Airbnb)`,
      properties: [ctx.channexPropertyId],
      // TODO confirm: Airbnb likely needs no hotel_id-style settings here, but may
      // need the OAuth connection reference.
      settings: {},
      rate_plans: build.mappings.map((m) => ({ rate_plan_id: m.rate_plan_id, settings: m.settings })),
    },
  });
  if (!created.ok) {
    result.error = `Channex rejected the Airbnb channel: ${created.error}`;
    return result;
  }
  const channelId = created.body?.data?.id ?? null;
  result.channel_id = channelId;

  await supabase.from("channels").upsert(
    { property_id: propertyId, channel: CHANNEL_ROW, ota_hotel_id: null, channex_channel_id: channelId, is_active: false },
    { onConflict: "property_id,channel" },
  );

  if (channelId) {
    const readiness = await channexRequest("POST", `/channels/${channelId}/check_readiness`);
    result.readiness = readiness.body;
    await supabase
      .from("channels")
      .update({ last_readiness: readiness.body })
      .eq("property_id", propertyId)
      .eq("channel", CHANNEL_ROW);
  }

  return result;
}

/** Orchestrator. step defaults to "begin"; pass "map" after Leon has authorised. */
export async function connectAirbnb(
  propertyId: string,
  opts: { step?: "begin" | "map" } = {},
): Promise<AirbnbConnectResult> {
  return opts.step === "map" ? completeAirbnbMapping(propertyId) : beginAirbnbOAuth(propertyId);
}

/** Pull an OAuth URL out of whatever envelope Channex returns (shape unconfirmed). */
function extractOAuthUrl(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const data = (obj.data ?? obj) as Record<string, unknown>;
  const attrs = (data.attributes as Record<string, unknown> | undefined) ?? data;
  for (const key of ["oauth_url", "authorization_url", "authorize_url", "redirect_url", "url"]) {
    const v = attrs[key] ?? data[key] ?? obj[key];
    if (typeof v === "string" && v.startsWith("http")) return v;
  }
  return null;
}

/** Pull the Airbnb listings out of a mapping_details response (shape unconfirmed). */
function extractAirbnbListings(body: unknown): AirbnbListing[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as Record<string, unknown>).data;
  const container = (data ?? body) as Record<string, unknown>;

  // Booking.com returns data.rooms; Airbnb may return data.listings or a flat
  // array. Accept the likely shapes without committing to one.
  const candidates: unknown[] = [];
  for (const key of ["listings", "rooms", "data"]) {
    const v = container[key];
    if (Array.isArray(v)) candidates.push(...v);
  }
  if (Array.isArray(data)) candidates.push(...data);

  const out: AirbnbListing[] = [];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const attrs = (rec.attributes as Record<string, unknown> | undefined) ?? rec;
    const id = rec.id ?? attrs.id ?? attrs.listing_id;
    const title = attrs.title ?? attrs.name ?? rec.title ?? rec.name;
    if (id != null && typeof title === "string") out.push({ id: String(id), title });
  }
  return out;
}
