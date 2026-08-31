import { db } from "./db";
import { channexRequest } from "./channex";
import { addDays } from "./dates";
import type { AriRow, Property, RoomType } from "./types";

/**
 * Channex webhooks are a notification, not the booking, and they can arrive out
 * of order. Everything here pulls the revision by id and works from that.
 */

export type BookingRoom = {
  room_type_id: string | null;
  rate_plan_id: string | null;
  checkin_date: string;
  checkout_date: string;
  amount?: string;
};

export type BookingRevision = {
  id: string;
  booking_id?: string;
  revision_id?: string;
  property_id: string;
  unique_id?: string;
  ota_reservation_code?: string;
  ota_name?: string;
  status: "new" | "modified" | "cancelled" | string;
  arrival_date: string;
  departure_date: string;
  amount?: string;
  currency?: string;
  customer?: { name?: string; surname?: string };
  rooms?: BookingRoom[];
};

export type IngestResult = {
  revision_id: string;
  status: string;
  acknowledged: boolean;
  availability_touched: number;
  forwarded: boolean;
  error: string | null;
};

/** One room night held, keyed by our room type and date. */
type Effect = Record<string, number>;

export async function fetchRevision(revisionId: string, propertyId?: string | null): Promise<BookingRevision | null> {
  const result = await channexRequest<{ data?: { attributes?: BookingRevision } }>(
    "GET",
    `/booking_revisions/${revisionId}`,
    undefined,
    { propertyId: propertyId ?? null },
  );
  if (!result.ok || !result.body) return null;
  return result.body.data?.attributes ?? null;
}

/**
 * The feed only ever returns what has not been acknowledged, so it doubles as
 * the recovery path when a webhook is missed.
 */
export async function fetchFeed(channexPropertyId?: string | null): Promise<BookingRevision[]> {
  const params = new URLSearchParams();
  if (channexPropertyId) params.set("filter[property_id]", channexPropertyId);
  params.set("order[inserted_at]", "asc");
  params.set("pagination[limit]", "100");

  const out: BookingRevision[] = [];
  for (let page = 1; page <= 20; page++) {
    params.set("pagination[page]", String(page));
    const result = await channexRequest<{
      data?: { attributes?: BookingRevision }[];
      meta?: { total?: number; page?: number; limit?: number };
    }>("GET", `/booking_revisions/feed?${params.toString()}`);
    if (!result.ok || !result.body?.data) break;
    const batch = result.body.data.map((d) => d.attributes).filter(Boolean) as BookingRevision[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export async function ingestRevision(revision: BookingRevision): Promise<IngestResult> {
  const supabase = db();
  const revisionId = revision.id ?? revision.revision_id;
  const bookingId = revision.booking_id ?? revision.id;

  const result: IngestResult = {
    revision_id: revisionId,
    status: revision.status,
    acknowledged: false,
    availability_touched: 0,
    forwarded: false,
    error: null,
  };

  const { data: propertyRow } = await supabase
    .from("properties")
    .select("*")
    .eq("channex_property_id", revision.property_id)
    .maybeSingle();
  const property = propertyRow as Property | null;

  // Stored before anything else is attempted. A redelivery finds the row on
  // revision_id and never lands twice.
  const { data: existing } = await supabase
    .from("inbound_bookings")
    .select("id, acknowledged_at, applied_at, forwarded_at")
    .eq("revision_id", revisionId)
    .maybeSingle();

  if (!existing) {
    const { error } = await supabase.from("inbound_bookings").insert({
      property_id: property?.id ?? null,
      channex_booking_id: bookingId,
      revision_id: revisionId,
      ota_name: revision.ota_name ?? null,
      ota_reservation_code: revision.ota_reservation_code ?? null,
      status: revision.status,
      arrival_date: revision.arrival_date ?? null,
      departure_date: revision.departure_date ?? null,
      guest_name: [revision.customer?.name, revision.customer?.surname].filter(Boolean).join(" ") || null,
      amount: revision.amount ? Number(revision.amount) : null,
      currency: revision.currency ?? null,
      payload: revision,
    });
    if (error && !error.message.includes("duplicate")) {
      result.error = error.message;
      return result;
    }
  }

  // Acknowledge early. Channex re-present an unacknowledged booking for thirty
  // minutes and then complain, and the acknowledgement is a certification step
  // in its own right.
  if (!existing?.acknowledged_at) {
    const ack = await channexRequest("POST", `/booking_revisions/${revisionId}/ack`, undefined, {
      propertyId: property?.id ?? null,
    });
    if (ack.ok) {
      result.acknowledged = true;
      await supabase
        .from("inbound_bookings")
        .update({ acknowledged_at: new Date().toISOString() })
        .eq("revision_id", revisionId);
    } else {
      result.error = ack.error;
    }
  } else {
    result.acknowledged = true;
  }

  if (!property) {
    result.error = result.error ?? "No property here maps to that Channex property";
    return result;
  }

  if (!existing?.applied_at) {
    result.availability_touched = await applyAvailability(property, bookingId, revisionId, revision);
  }

  if (!existing?.forwarded_at) {
    result.forwarded = await forwardDownstream(property, revision);
  }

  return result;
}

/**
 * Availability is recalculated as an absolute number, never nudged by a delta.
 * Channex decrement their own copy on confirmation and that setting cannot be
 * turned off, so an absolute push is the only thing that stays correct whichever
 * side moved first.
 */
async function applyAvailability(
  property: Property,
  bookingId: string,
  revisionId: string,
  revision: BookingRevision,
): Promise<number> {
  const supabase = db();

  const { data: roomTypeRows } = await supabase.from("room_types").select("*").eq("property_id", property.id);
  const roomTypes = (roomTypeRows ?? []) as RoomType[];
  const byChannexId = new Map(roomTypes.filter((r) => r.channex_room_type_id).map((r) => [r.channex_room_type_id as string, r]));

  // Whatever the last applied revision of this booking held has to be released
  // before the new one takes its rooms.
  const { data: prior } = await supabase
    .from("inbound_bookings")
    .select("applied_effect")
    .eq("channex_booking_id", bookingId)
    .not("applied_effect", "is", null)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const priorEffect = (prior?.applied_effect ?? {}) as Effect;
  const nextEffect: Effect = revision.status === "cancelled" ? {} : effectOf(revision, byChannexId);

  const net: Effect = {};
  for (const [key, held] of Object.entries(priorEffect)) net[key] = (net[key] ?? 0) + held;
  for (const [key, held] of Object.entries(nextEffect)) net[key] = (net[key] ?? 0) - held;

  const touched = Object.entries(net).filter(([, delta]) => delta !== 0);
  if (touched.length > 0) {
    const dates = touched.map(([key]) => key.split("|")[1]).sort();
    const { data: current } = await supabase
      .from("ari")
      .select("*")
      .eq("property_id", property.id)
      .is("rate_plan_id", null)
      .gte("date", dates[0])
      .lte("date", dates[dates.length - 1]);

    const currentByKey = new Map(
      ((current ?? []) as AriRow[]).map((r) => [[r.room_type_id, r.date].join("|"), r]),
    );

    const rows = touched.map(([key, delta]) => {
      const [roomTypeId, date] = key.split("|");
      const existing = currentByKey.get(key);
      const roomType = roomTypes.find((r) => r.id === roomTypeId);
      const base = existing?.availability ?? roomType?.count_of_rooms ?? 0;
      const ceiling = roomType?.count_of_rooms ?? base;
      return {
        property_id: property.id,
        room_type_id: roomTypeId,
        rate_plan_id: null,
        date,
        availability: Math.max(0, Math.min(ceiling, base + delta)),
      };
    });

    await supabase.from("ari").upsert(rows, { onConflict: "room_type_id,rate_plan_id,date" });
  }

  await supabase
    .from("inbound_bookings")
    .update({ applied_at: new Date().toISOString(), applied_effect: nextEffect })
    .eq("revision_id", revisionId);

  return touched.length;
}

function effectOf(revision: BookingRevision, byChannexId: Map<string, RoomType>): Effect {
  const effect: Effect = {};
  for (const room of revision.rooms ?? []) {
    if (!room.room_type_id) continue;
    const roomType = byChannexId.get(room.room_type_id);
    if (!roomType) continue;
    // Nights, so the departure date is never held.
    for (let date = room.checkin_date; date < room.checkout_date; date = addDays(date, 1)) {
      const key = [roomType.id, date].join("|");
      effect[key] = (effect[key] ?? 0) + 1;
    }
  }
  return effect;
}

/**
 * Downstream keeps the booking. This service only ever owns availability, so the
 * revision is handed on exactly as Channex sent it.
 */
async function forwardDownstream(property: Property, revision: BookingRevision): Promise<boolean> {
  if (!property.downstream_url) return false;
  const supabase = db();
  const revisionId = revision.id ?? revision.revision_id;

  try {
    const { data: row } = await supabase
      .from("properties")
      .select("downstream_secret")
      .eq("id", property.id)
      .single();

    const res = await fetch(property.downstream_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(row?.downstream_secret ? { "x-hub-secret": row.downstream_secret as string } : {}),
      },
      body: JSON.stringify({ source: "channex", property_id: property.id, revision }),
    });

    if (!res.ok) {
      await supabase
        .from("inbound_bookings")
        .update({ forward_error: `${res.status} ${(await res.text()).slice(0, 500)}` })
        .eq("revision_id", revisionId);
      return false;
    }

    await supabase
      .from("inbound_bookings")
      .update({ forwarded_at: new Date().toISOString(), forward_error: null })
      .eq("revision_id", revisionId);
    return true;
  } catch (e) {
    await supabase
      .from("inbound_bookings")
      .update({ forward_error: e instanceof Error ? e.message : String(e) })
      .eq("revision_id", revisionId);
    return false;
  }
}
