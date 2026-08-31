import { db } from "./db";
import { channexRequest } from "./channex";
import { FULL_SYNC_DAYS } from "./fullsync";
import type { Account, Property, RatePlan, RoomType } from "./types";

/**
 * Everything Channex needs created before a single rate can be pushed, and the
 * mapping layer certification asks for. Each step records the Channex id back
 * onto our row, so running this twice is safe and skips what already exists.
 */

export type ProvisionStep = { entity: string; name: string; id: string | null; created: boolean; error: string | null };

export async function provisionProperty(propertyId: string): Promise<ProvisionStep[]> {
  const supabase = db();
  const steps: ProvisionStep[] = [];

  const { data: propertyRow } = await supabase.from("properties").select("*").eq("id", propertyId).single();
  const property = propertyRow as Property | null;
  if (!property) return [{ entity: "property", name: propertyId, id: null, created: false, error: "not found" }];

  const { data: accountRow } = await supabase.from("accounts").select("*").eq("id", property.account_id).single();
  const account = accountRow as Account | null;
  if (!account) return [{ entity: "account", name: property.account_id, id: null, created: false, error: "not found" }];

  // 1. The group. An account here is a Channex group, which is also the thing a
  // channel connection is created against.
  let groupId = account.channex_group_id;
  if (!groupId) {
    const res = await channexRequest<{ data?: { id?: string } }>("POST", "/groups", {
      group: { title: account.name },
    });
    groupId = res.body?.data?.id ?? null;
    steps.push({ entity: "group", name: account.name, id: groupId, created: res.ok, error: res.error });
    if (!groupId) return steps;
    await supabase.from("accounts").update({ channex_group_id: groupId }).eq("id", account.id);
  } else {
    steps.push({ entity: "group", name: account.name, id: groupId, created: false, error: null });
  }

  // 2. The property.
  let channexPropertyId = property.channex_property_id;
  if (!channexPropertyId) {
    const res = await channexRequest<{ data?: { id?: string } }>("POST", "/properties", {
      property: {
        title: property.name,
        currency: property.currency,
        timezone: property.timezone,
        group_id: groupId,
        property_type: "apartment",
        settings: {
          // Left at its default on modification and cancellation, which is what
          // Channex recommend: this service decides availability, not them.
          allow_availability_autoupdate_on_modification: false,
          allow_availability_autoupdate_on_cancellation: false,
          min_stay_type: "both",
          state_length: FULL_SYNC_DAYS,
        },
      },
    });
    channexPropertyId = res.body?.data?.id ?? null;
    steps.push({ entity: "property", name: property.name, id: channexPropertyId, created: res.ok, error: res.error });
    if (!channexPropertyId) return steps;
    await supabase.from("properties").update({ channex_property_id: channexPropertyId }).eq("id", property.id);
  } else {
    steps.push({ entity: "property", name: property.name, id: channexPropertyId, created: false, error: null });
  }

  // 3. Room types.
  const { data: roomTypeRows } = await supabase.from("room_types").select("*").eq("property_id", property.id).order("sort");
  const roomTypes = (roomTypeRows ?? []) as RoomType[];

  for (const roomType of roomTypes) {
    if (roomType.channex_room_type_id) {
      steps.push({ entity: "room_type", name: roomType.name, id: roomType.channex_room_type_id, created: false, error: null });
      continue;
    }
    const res = await channexRequest<{ data?: { id?: string } }>("POST", "/room_types", {
      room_type: {
        property_id: channexPropertyId,
        title: roomType.name,
        count_of_rooms: roomType.count_of_rooms,
        occ_adults: roomType.occ_adults,
        occ_children: roomType.occ_children,
        occ_infants: roomType.occ_infants,
        default_occupancy: roomType.default_occupancy,
        room_kind: "room",
      },
    });
    const id = res.body?.data?.id ?? null;
    steps.push({ entity: "room_type", name: roomType.name, id, created: res.ok, error: res.error });
    if (id) {
      roomType.channex_room_type_id = id;
      await supabase.from("room_types").update({ channex_room_type_id: id }).eq("id", roomType.id);
    }
  }

  // 4. Rate plans.
  const { data: ratePlanRows } = roomTypes.length
    ? await supabase.from("rate_plans").select("*").in("room_type_id", roomTypes.map((r) => r.id))
    : { data: [] as RatePlan[] };

  for (const plan of (ratePlanRows ?? []) as RatePlan[]) {
    if (plan.channex_rate_plan_id) {
      steps.push({ entity: "rate_plan", name: plan.name, id: plan.channex_rate_plan_id, created: false, error: null });
      continue;
    }
    const roomType = roomTypes.find((r) => r.id === plan.room_type_id);
    if (!roomType?.channex_room_type_id) {
      steps.push({ entity: "rate_plan", name: plan.name, id: null, created: false, error: "room type is not mapped" });
      continue;
    }
    const res = await channexRequest<{ data?: { id?: string } }>("POST", "/rate_plans", {
      rate_plan: {
        title: plan.name,
        property_id: channexPropertyId,
        room_type_id: roomType.channex_room_type_id,
        currency: property.currency,
        sell_mode: "per_room",
        rate_mode: "manual",
        parent_rate_plan_id: null,
        options: [{ occupancy: plan.occupancy, is_primary: true, rate: 0 }],
      },
    });
    const id = res.body?.data?.id ?? null;
    steps.push({ entity: "rate_plan", name: plan.name, id, created: res.ok, error: res.error });
    if (id) await supabase.from("rate_plans").update({ channex_rate_plan_id: id }).eq("id", plan.id);
  }

  return steps;
}

export type ConnectResult = {
  hotel_id: string;
  test_connection: boolean;
  channel_id: string | null;
  mapped: number;
  readiness: unknown;
  error: string | null;
};

/**
 * Connect a property to Booking.com. Only one connection per hotel id exists
 * across the whole of Channex, and test_connection answers true even when the
 * hotel is already taken, so the 422 on create is the honest check.
 */
export async function connectBookingCom(propertyId: string, hotelId: string): Promise<ConnectResult> {
  const supabase = db();
  const result: ConnectResult = {
    hotel_id: hotelId,
    test_connection: false,
    channel_id: null,
    mapped: 0,
    readiness: null,
    error: null,
  };

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

  const test = await channexRequest<{ data?: { success?: boolean } }>("POST", "/channels/test_connection", {
    channel: "BookingCom",
    settings: { hotel_id: hotelId },
  });
  result.test_connection = test.body?.data?.success === true;

  const { data: roomTypeRows } = await supabase.from("room_types").select("*").eq("property_id", propertyId);
  const roomTypes = (roomTypeRows ?? []) as (RoomType & { ota_room_type_code: string | null })[];
  const { data: ratePlanRows } = roomTypes.length
    ? await supabase.from("rate_plans").select("*").in("room_type_id", roomTypes.map((r) => r.id))
    : { data: [] };

  const mappings = [];
  for (const plan of (ratePlanRows ?? []) as (RatePlan & { ota_rate_plan_code: string | null })[]) {
    const roomType = roomTypes.find((r) => r.id === plan.room_type_id);
    if (!plan.channex_rate_plan_id || !roomType?.ota_room_type_code) continue;
    mappings.push({
      rate_plan_id: plan.channex_rate_plan_id,
      settings: {
        room_type_code: roomType.ota_room_type_code,
        rate_plan_code: plan.ota_rate_plan_code ?? roomType.ota_room_type_code,
        occupancy: plan.occupancy,
        primary_occ: true,
        readonly: false,
      },
    });
  }
  result.mapped = mappings.length;
  if (mappings.length === 0) {
    result.error = "No rate plan carries a Booking.com room type code yet";
    return result;
  }

  const created = await channexRequest<{ data?: { id?: string } }>("POST", "/channels", {
    channel: {
      channel: "BookingCom",
      group_id: groupId,
      title: property.name,
      properties: [property.channex_property_id],
      settings: { hotel_id: hotelId },
      rate_plans: mappings,
    },
  });

  if (!created.ok) {
    result.error =
      created.status === 422
        ? "Channex rejected the connection, which usually means this hotel id is already connected somewhere on the platform"
        : created.error;
    return result;
  }

  const channelId = created.body?.data?.id ?? null;
  result.channel_id = channelId;

  await supabase.from("channels").upsert(
    {
      property_id: propertyId,
      channel: "BookingCom",
      ota_hotel_id: hotelId,
      channex_channel_id: channelId,
      is_active: false,
    },
    { onConflict: "property_id,channel" },
  );

  if (channelId) {
    // Connections are always created inactive. Readiness says what still blocks
    // activation, and an empty data array is the all clear.
    const readiness = await channexRequest("POST", `/channels/${channelId}/check_readiness`);
    result.readiness = readiness.body;
    await supabase
      .from("channels")
      .update({ last_readiness: readiness.body })
      .eq("property_id", propertyId)
      .eq("channel", "BookingCom");
  }

  return result;
}
