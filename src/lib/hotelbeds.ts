import { db } from "./db";
import { channexRequest, compact } from "./channex";
import type { Property, RatePlan, RoomType } from "./types";

/**
 * Connect a property to Hotelbeds through Channex, created switched off.
 *
 * Hotelbeds is a RECEIVE-ONLY bedbank, not an OTA. Channex pushes availability
 * and rates (ARI) up to Hotelbeds and receives bookings back as references;
 * there is no guest-contact/messaging surface the way Booking.com or Expedia
 * have. So the connect here is: push ARI out, receive bookings in. The receive
 * side already exists in bookings.ts, which files a Hotelbeds reservation by its
 * ota_name (prefix "HBD"); this module builds the CONNECT + mapping + ARI-out
 * side only.
 *
 * Shape mirrors connectExpedia in provision.ts, for the same reason: like
 * Expedia, the Hotelbeds room and rate codes are Hotelbeds' own identifiers that
 * come from Leon / the Channex mapping_details once connected, not from codes we
 * store on our rows the way connectBookingCom reads them. So the mapping is
 * driven by a pairing passed in, never hardcoded and never derived from names.
 *
 * Additive only: this writes a channels row with channel="Hotelbeds" and touches
 * nothing connectBookingCom, connectExpedia, or any live listing depends on.
 */

/**
 * The Channex channel-type string for Hotelbeds.
 *
 * TODO(leon/channex): CONFIRM THIS VALUE before any live connect. Booking.com is
 * "BookingCom". Hotelbeds' code on Channex is believed to be "Hotelbeds", but
 * this is NOT a value to guess into a live call. Confirm against the Channex
 * Hotelbeds mapping docs or a staging test_connection that returns success, then
 * set it here. Nothing below invents it elsewhere, so this is the one place to
 * change.
 */
export const HOTELBEDS_CHANNEL_TYPE = "Hotelbeds";

/**
 * One pairing line from Leon (or read off Channex mapping_details once the hotel
 * is connected). It says which Hotelbeds room maps to which hub room type, and
 * gives the Hotelbeds rate code for that room. Both are Hotelbeds' own codes, so
 * they are supplied, never derived from our names. There is no Hotelbeds rooms
 * file in the repo yet, by design: the pairing is the input.
 */
export type HotelbedsRoomPair = {
  /** The hub room_type this Hotelbeds room is, by room_types.id or exact name. */
  hubRoomType: string;
  /** The Hotelbeds room code for this room (from Hotelbeds / Channex mapping_details). */
  hotelbedsRoomCode: string;
  /** The Hotelbeds rate code / board code for that room. */
  hotelbedsRatePlanCode: string;
  /**
   * The Hotelbeds room's max occupancy. Optional; when given it is checked
   * against the occupancy the hub prices for so a Hotelbeds room set lower than
   * we sell is surfaced here rather than failing opaquely at activation (the
   * Hotelbeds twin of Booking.com's OCCUPANCY_EXCEEDS_MAX_PERSONS).
   */
  hotelbedsMaxOccupancy?: number;
};

/** A single /channels rate_plan mapping entry in Channex's shape. */
export type HotelbedsMapping = {
  rate_plan_id: string;
  settings: {
    room_type_code: string;
    rate_plan_code: string;
    occupancy: number;
    primary_occ: boolean;
    readonly: boolean;
  };
};

export type HotelbedsMappingBuild = {
  mappings: HotelbedsMapping[];
  /** Pairings that produced no mapping, each with the reason. */
  unmapped: string[];
  /** Rooms where Hotelbeds sells fewer guests than the hub prices for. */
  occupancyWarnings: string[];
};

/**
 * Pure mapping builder, pulled out so it can be tested with a sample pairing and
 * no database or Channex call. Given the hub's room types and rate plans (already
 * provisioned on Channex, so each carries a channex_rate_plan_id) and Leon's
 * pairing, it returns the rate_plan mapping array for POST /channels, mapping each
 * Hotelbeds room's rate code to the hub room type's primary rate plan.
 */
export function buildHotelbedsMappings(
  roomTypes: RoomType[],
  ratePlans: RatePlan[],
  pairing: HotelbedsRoomPair[],
): HotelbedsMappingBuild {
  const mappings: HotelbedsMapping[] = [];
  const unmapped: string[] = [];
  const occupancyWarnings: string[] = [];

  for (const pair of pairing) {
    const roomType = roomTypes.find((r) => r.id === pair.hubRoomType || r.name === pair.hubRoomType);
    if (!roomType) {
      unmapped.push(`${pair.hubRoomType}: no hub room type with that id or name`);
      continue;
    }
    if (!pair.hotelbedsRoomCode?.trim() || !pair.hotelbedsRatePlanCode?.trim()) {
      unmapped.push(`${roomType.name}: pairing is missing the Hotelbeds room code or rate code`);
      continue;
    }

    // The primary rate plan is the one the engine prices; it is what the
    // Hotelbeds rate code maps onto. It must already be on Channex.
    const plansForRoom = ratePlans.filter((p) => p.room_type_id === roomType.id);
    const plan = plansForRoom.find((p) => p.is_primary && p.channex_rate_plan_id) ?? plansForRoom.find((p) => p.channex_rate_plan_id);
    if (!plan?.channex_rate_plan_id) {
      unmapped.push(`${roomType.name}: no provisioned (Channex) rate plan to map onto; run provisionProperty first`);
      continue;
    }

    const pricedOccupancy = plan.occupancy;
    if (typeof pair.hotelbedsMaxOccupancy === "number" && pair.hotelbedsMaxOccupancy < pricedOccupancy) {
      occupancyWarnings.push(
        `${roomType.name}: Hotelbeds room ${pair.hotelbedsRoomCode} sleeps ${pair.hotelbedsMaxOccupancy}, hub prices for ${pricedOccupancy}. ` +
          `Raise the room's max occupancy on the Hotelbeds side to at least ${pricedOccupancy} or the channel rejects activation.`,
      );
    }

    mappings.push({
      rate_plan_id: plan.channex_rate_plan_id,
      settings: {
        room_type_code: pair.hotelbedsRoomCode,
        rate_plan_code: pair.hotelbedsRatePlanCode,
        occupancy: pricedOccupancy,
        primary_occ: true,
        readonly: false,
      },
    });
  }

  return { mappings, unmapped, occupancyWarnings };
}

/**
 * Channel-level connectivity settings for Hotelbeds.
 *
 * TODO(leon/channex): CONFIRM the Hotelbeds settings shape before a live connect.
 * Booking.com's settings is { hotel_id }. For a Hotelbeds bedbank connection the
 * contract type is the key input that governs how Hotelbeds takes allotment and
 * rates, and only Leon can confirm it. The exact Channex field name for the
 * Hotelbeds hotel identifier and for the contract type is unconfirmed, so both
 * are taken as inputs and passed through compact() rather than guessed. Set the
 * real field names here once confirmed against the Channex Hotelbeds docs.
 */
export type HotelbedsConnectOptions = {
  /**
   * The Hotelbeds contract type. Governs how Hotelbeds takes allotment/rates.
   * Only Leon can confirm it; left undefined it is simply not sent, so the
   * structure ships without a guessed value baked into a live call.
   */
  contractType?: string;
  /**
   * Any other Channex channel settings the confirmed Hotelbeds contract needs
   * (credentials/connectivity beyond the hotel id). Passed straight through.
   */
  extraSettings?: Record<string, unknown>;
};

export type HotelbedsConnectResult = {
  hotel_id: string;
  contract_type: string | null;
  test_connection: boolean;
  channel_id: string | null;
  mapped: number;
  unmapped: string[];
  occupancy_warnings: string[];
  readiness: unknown;
  error: string | null;
};

/**
 * Connect a property to Hotelbeds, created switched off. Takes the Hotelbeds
 * hotel identifier, the room/rate pairing, and (optionally, until Leon confirms
 * it) the contract type. Writes a channels row with channel="Hotelbeds". Leaves
 * connectBookingCom, connectExpedia, and every existing channel untouched.
 */
export async function connectHotelbeds(
  propertyId: string,
  hotelbedsHotelId: string,
  pairing: HotelbedsRoomPair[],
  options: HotelbedsConnectOptions = {},
): Promise<HotelbedsConnectResult> {
  const supabase = db();
  const result: HotelbedsConnectResult = {
    hotel_id: hotelbedsHotelId,
    contract_type: options.contractType ?? null,
    test_connection: false,
    channel_id: null,
    mapped: 0,
    unmapped: [],
    occupancy_warnings: [],
    readiness: null,
    error: null,
  };

  if (!hotelbedsHotelId?.trim()) {
    result.error = "A Hotelbeds hotel identifier is required";
    return result;
  }
  if (!pairing?.length) {
    result.error = "A room pairing is required (hub room type -> Hotelbeds room code + rate code)";
    return result;
  }

  const { data: propertyRow } = await supabase.from("properties").select("*").eq("id", propertyId).single();
  const property = propertyRow as Property | null;
  if (!property?.channex_property_id) {
    result.error = "Provision the property on Channex first";
    return result;
  }

  const { data: accountRow } = await supabase
    .from("accounts")
    .select("channex_group_id")
    .eq("id", property.account_id)
    .single();
  const groupId = accountRow?.channex_group_id as string | null;
  if (!groupId) {
    result.error = "The account has no Channex group";
    return result;
  }

  // See HotelbedsConnectOptions: the settings shape and contract-type field name
  // are unconfirmed, so settings is assembled from inputs and compacted (null/
  // undefined dropped), never guessed. contract_type key name here is a
  // placeholder pending the Channex Hotelbeds docs / the confirmed contract type.
  const settings = compact({
    hotel_id: hotelbedsHotelId,
    contract_type: options.contractType,
    ...(options.extraSettings ?? {}),
  });

  const test = await channexRequest<{ data?: { success?: boolean } }>("POST", "/channels/test_connection", {
    channel: HOTELBEDS_CHANNEL_TYPE,
    settings,
  });
  result.test_connection = test.body?.data?.success === true;

  const { data: roomTypeRows } = await supabase.from("room_types").select("*").eq("property_id", propertyId);
  const roomTypes = (roomTypeRows ?? []) as RoomType[];
  const { data: ratePlanRows } = roomTypes.length
    ? await supabase.from("rate_plans").select("*").in("room_type_id", roomTypes.map((r) => r.id))
    : { data: [] as RatePlan[] };

  const built = buildHotelbedsMappings(roomTypes, (ratePlanRows ?? []) as RatePlan[], pairing);
  result.mapped = built.mappings.length;
  result.unmapped = built.unmapped;
  result.occupancy_warnings = built.occupancyWarnings;
  if (built.mappings.length === 0) {
    result.error = `No Hotelbeds room could be mapped: ${built.unmapped.join("; ") || "empty pairing"}`;
    return result;
  }

  const created = await channexRequest<{ data?: { id?: string } }>("POST", "/channels", {
    channel: {
      channel: HOTELBEDS_CHANNEL_TYPE,
      group_id: groupId,
      title: `${property.name} (Hotelbeds)`,
      properties: [property.channex_property_id],
      settings,
      rate_plans: built.mappings,
    },
  });

  if (!created.ok) {
    result.error =
      created.status === 422
        ? "Channex rejected the Hotelbeds connection (422), often an already-connected hotel id, an occupancy mismatch, a missing/incorrect contract type, or an unconfirmed channel type/settings shape"
        : created.error;
    return result;
  }

  const channelId = created.body?.data?.id ?? null;
  result.channel_id = channelId;

  await supabase.from("channels").upsert(
    {
      property_id: propertyId,
      channel: "Hotelbeds",
      ota_hotel_id: hotelbedsHotelId,
      channex_channel_id: channelId,
      is_active: false,
    },
    { onConflict: "property_id,channel" },
  );

  if (channelId) {
    // Connections are always created inactive. Readiness says what still blocks
    // activation; activation is a separate, later, explicitly-asked-for step.
    const readiness = await channexRequest("POST", `/channels/${channelId}/check_readiness`);
    result.readiness = readiness.body;
    await supabase
      .from("channels")
      .update({ last_readiness: readiness.body })
      .eq("property_id", propertyId)
      .eq("channel", "Hotelbeds");
  }

  return result;
}
