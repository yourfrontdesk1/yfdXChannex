import { db } from "./db";
import { channexRequest } from "./channex";
import { addDays } from "./dates";
import { applyEffectChange, holdKey, type Effect } from "./holds";
import { pickFreeApartment } from "./parkside";
import type { Property, RoomType } from "./types";

/**
 * Channex webhooks are a notification, not the booking, and they can arrive out
 * of order. Everything here pulls the revision by id and works from that.
 */

export type BookingRoom = {
  room_type_id: string | null;
  rate_plan_id: string | null;
  occupancy?: { adults?: number; children?: number; infants?: number };
  /** Per night breakdown, each night dated. The portal stores it as nightly_rates. */
  days?: Record<string, string | number> | null;
  taxes?: unknown;
  services?: unknown;
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
  customer?: {
    name?: string; surname?: string; mail?: string; phone?: string;
    address?: string; city?: string; zip?: string; country?: string; language?: string;
  };
  occupancy?: { adults?: number; children?: number; infants?: number };
  notes?: string | null;
  arrival_hour?: string | null;
  inserted_at?: string;
  ota_commission?: string | number | null;
  payment_collect?: string | null;
  payment_type?: string | null;
  services?: unknown;
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

  const { touched } = await applyEffectChange(property, priorEffect, nextEffect);

  await supabase
    .from("inbound_bookings")
    .update({ applied_at: new Date().toISOString(), applied_effect: nextEffect })
    .eq("revision_id", revisionId);

  return touched;
}

function effectOf(revision: BookingRevision, byChannexId: Map<string, RoomType>): Effect {
  const effect: Effect = {};
  for (const room of revision.rooms ?? []) {
    if (!room.room_type_id) continue;
    const roomType = byChannexId.get(room.room_type_id);
    if (!roomType) continue;
    // Nights, so the departure date is never held.
    for (let date = room.checkin_date; date < room.checkout_date; date = addDays(date, 1)) {
      const key = holdKey(roomType.id, date);
      effect[key] = (effect[key] ?? 0) + 1;
    }
  }
  return effect;
}

const OTA_PREFIX: Record<string, string> = {
  bookingcom: "BDC",
  "booking.com": "BDC",
  hotelbeds: "HBD",
  expedia: "EXP",
  airbnb: "ABB",
  agoda: "AGD",
};

/**
 * The reference the rest of the estate already uses.
 *
 * Bookings for these apartments arrive from more than one feed, referenced as
 * BDC-6639721282 or HBD-1114132-... Channex hands over the bare number. Send it
 * bare and the same guest appears twice under two references, with two payment
 * links. Matching the convention means whichever feed arrives second updates the
 * booking rather than creating a rival to it.
 */
function externalRefFor(revision: BookingRevision, revisionId: string): string {
  const raw = revision.ota_reservation_code ?? revision.unique_id ?? revision.booking_id ?? revisionId;
  const prefix = OTA_PREFIX[String(revision.ota_name ?? "").toLowerCase().replace(/\s+/g, "")];
  return prefix && !String(raw).includes("-") ? `${prefix}-${raw}` : String(raw);
}

/**
 * Downstream keeps the booking. This service only ever owns availability, so the
 * revision is handed on exactly as Channex sent it.
 */
async function forwardDownstream(property: Property, revision: BookingRevision): Promise<boolean> {
  if (!property.downstream_url) return false;

  // NEW direct-forward flow, opt-in per property. Default false (see
  // db/015_use_direct_forward.sql) keeps every existing property on the live
  // path below, so nothing changes for production until a property has
  // use_direct_forward set true. This is the only gate on the new flow.
  if (property.use_direct_forward) {
    return forwardDirect(property, revision);
  }

  const supabase = db();
  const revisionId = revision.id ?? revision.revision_id;

  // The Victory Suites guest portal has its own booking API, which also mints
  // the guest link and the payment link. Handing it the raw Channex revision
  // would mean building a second importer inside a live system, so the revision
  // is translated into the shape that API already speaks.
  if (property.downstream_url.includes("/api/external/bookings")) {
    return forwardToGuestPortal(property, revision);
  }

  // YourFrontDesk owns the guest for this portfolio: it creates the portal
  // booking, keeps the link and decides what the guest is told. So it gets a
  // reservation in plain terms rather than a Channex revision, and no Channex
  // shape leaks into a system that should not have to know what Channex is.
  if (property.downstream_url.includes("channex-webhook")) {
    return forwardToYourFrontDesk(property, revision);
  }

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


/**
 * Hands a reservation to YourFrontDesk in its own words.
 *
 * Everything Channex specific is resolved here: the uuid of a room type becomes
 * its name, and the bare OTA reference gains the prefix the rest of the estate
 * already uses, so whichever feed arrives second updates a booking instead of
 * creating a rival to it.
 */
async function forwardToYourFrontDesk(property: Property, revision: BookingRevision): Promise<boolean> {
  const supabase = db();
  const revisionId = revision.id ?? revision.revision_id;

  const { data: row } = await supabase
    .from("properties")
    .select("downstream_secret")
    .eq("id", property.id)
    .single();
  const secret = row?.downstream_secret as string | null;
  if (!secret) {
    await supabase
      .from("inbound_bookings")
      .update({ forward_error: "No downstream secret is set for this property" })
      .eq("revision_id", revisionId);
    return false;
  }

  const status = String(revision.status).toLowerCase();
  const event = status === "cancelled" ? "booking.cancelled" : status === "modified" ? "booking.modified" : "booking.new";

  const room = revision.rooms?.[0];
  let roomType: string | null = null;
  let roomTypeProperty: string | null = null;
  if (room?.room_type_id) {
    const { data: rt } = await supabase
      .from("room_types")
      .select("name, property_id")
      .eq("channex_room_type_id", room.room_type_id)
      .maybeSingle();
    roomType = (rt?.name as string | null) ?? null;
    roomTypeProperty = (rt?.property_id as string | null) ?? null;
  }

  // Somebody has to choose the flat. The portal will not: it resolves an
  // apartment only when the caller names one, and its reply carries none at all.
  // A booking sent without a room reaches the guest correctly and then belongs to
  // no apartment anywhere, which is the failure nobody would notice.
  let apartment: string | null = null;
  let roomNote: string | null = null;
  if (event !== "booking.cancelled" && roomType && roomTypeProperty) {
    // A booking that has already been given a flat keeps it. Choosing again on a
    // retry or an amendment hands the guest a second apartment and leaves the
    // first one held against nobody.
    const { data: already } = await supabase
      .from("inbound_bookings")
      .select("apartment")
      .eq("revision_id", revisionId)
      .maybeSingle();
    apartment = (already?.apartment as string | null) ?? null;

    const pick = apartment
      ? { room: apartment, reason: null as string | null, order: [] as string[] }
      : await pickFreeApartment(roomTypeProperty, roomType, revision.arrival_date, revision.departure_date);
    apartment = pick.room;
    if (apartment && !already?.apartment) {
      await supabase.from("inbound_bookings").update({ apartment }).eq("revision_id", revisionId);
    }
    // The order is kept even on success, so a question about why a guest got a
    // particular flat can be answered rather than guessed at.
    roomNote = pick.reason ?? (pick.order.length ? `rotation: ${pick.order.join(", ")}` : null);
  }

  // Everything Channex sends that the portal can hold. Anything dropped here is
  // gone for good: the revision is offered once, and a guest count, an arrival
  // time or a meal plan note that never arrives is one somebody has to chase by
  // hand later.
  const occ = room?.occupancy ?? revision.occupancy ?? {};
  const adults = occ.adults ?? null;
  const children = occ.children ?? null;
  const infants = occ.infants ?? null;
  const guestCount = [adults, children, infants].reduce<number>((n, v) => n + (v ?? 0), 0) || null;

  // The arrival hour belongs with the requests, because that is where anyone
  // reading the booking will look for it.
  const requests = [
    revision.arrival_hour ? `Arriving around ${revision.arrival_hour}` : null,
    revision.notes ? String(revision.notes).trim() : null,
  ].filter(Boolean).join("\n") || null;

  let ratePlanName: string | null = null;
  if (room?.rate_plan_id) {
    const { data: rp } = await supabase
      .from("rate_plans")
      .select("name")
      .eq("channex_rate_plan_id", room.rate_plan_id)
      .maybeSingle();
    ratePlanName = (rp?.name as string | null) ?? null;
  }

  const body = {
    event,
    external_ref: externalRefFor(revision, revisionId),
    room: apartment,
    revision_id: revisionId,
    echo_token: revisionId,
    guest: {
      first_name: revision.customer?.name ?? "Guest",
      last_name: revision.customer?.surname ?? (revision.ota_name ?? "Booking"),
      email: revision.customer?.mail ?? "",
      phone: revision.customer?.phone ?? "",
    },
    street: revision.customer?.address ?? null,
    city: revision.customer?.city ?? null,
    postcode: revision.customer?.zip ?? null,
    country: revision.customer?.country ?? null,
    language: revision.customer?.language ?? null,
    check_in: revision.arrival_date,
    check_out: revision.departure_date,
    room_type: roomType,
    // Plain English, because staff read this one.
    room_name: roomType,
    // The id, not just the name. YourFrontDesk files the booking against the
    // listing carrying this id, so a room renamed in an extranet cannot quietly
    // send a guest to the wrong listing, and the wrong listing is the wrong owner.
    room_type_id: room?.room_type_id ?? null,
    rate_plan: ratePlanName,
    source: revision.ota_name ?? "Booking.com",
    sending_system: "channex",
    ota_status: revision.status ?? null,
    amount: revision.amount ? Number(revision.amount) : null,
    amount_after_tax: revision.amount ? Number(revision.amount) : null,
    currency: revision.currency ?? "GBP",
    adults,
    children,
    infants,
    num_guests: guestCount,
    units_booked: revision.rooms?.length ?? 1,
    special_requests: requests,
    nightly_rates: room?.days ?? null,
    extras: revision.services ?? null,
    created_at: revision.inserted_at ?? null,
  };

  try {
    const res = await fetch(property.downstream_url as string, {
      method: "POST",
      headers: { "content-type": "application/json", "x-channex-webhook-secret": secret },
      body: JSON.stringify(body),
    });
    const text = await res.text();

    if (!res.ok) {
      await supabase
        .from("inbound_bookings")
        .update({ forward_error: `${res.status} ${text.slice(0, 500)}` })
        .eq("revision_id", revisionId);
      return false;
    }

    let payload: { portal_url?: string | null; status?: string; detail?: string | null } = {};
    try { payload = JSON.parse(text); } catch {}

    await supabase
      .from("inbound_bookings")
      .update({
        forwarded_at: new Date().toISOString(),
        // A reservation that landed but was not filed, or was not messaged, is
        // not an error to retry. It is a note worth keeping where a person will
        // see it.
        forward_error: payload.detail ?? roomNote,
        portal_url: payload.portal_url ?? null,
      })
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

/**
 * Hands a booking to the Victory Suites guest portal, which creates the guest,
 * the booking and the payment link and gives back the guest's own portal URL.
 *
 * No apartment is named. The portal decides which of the twelve units a room
 * type booking becomes, exactly as it does for every other channel, so there is
 * one place that answers "which flat is this guest in" rather than two that can
 * disagree.
 */
async function forwardToGuestPortal(property: Property, revision: BookingRevision): Promise<boolean> {
  const supabase = db();
  const revisionId = revision.id ?? revision.revision_id;
  const key = process.env.PORTAL_API_KEY;
  if (!key) return false;

  const cancelled = String(revision.status).toLowerCase() === "cancelled";

  const externalRef = externalRefFor(revision, revisionId);
  const room = revision.rooms?.[0];

  // Channex names a room type by uuid. The portal shows this to staff, so it
  // gets the words a person uses, "Executive Studio", not an identifier.
  let roomName: string | null = null;
  if (room?.room_type_id) {
    const { data: roomType } = await supabase
      .from("room_types")
      .select("name")
      .eq("channex_room_type_id", room.room_type_id)
      .maybeSingle();
    roomName = (roomType?.name as string | null) ?? null;
  }

  const body: Record<string, unknown> = cancelled
    ? { status: "cancelled", external_ref: externalRef }
    : {
        guest: {
          first_name: revision.customer?.name ?? "Guest",
          last_name: revision.customer?.surname ?? (revision.ota_name ?? "Booking"),
        },
        check_in: revision.arrival_date,
        check_out: revision.departure_date,
        source: revision.ota_name ?? "Booking.com",
        channel: revision.ota_name ?? null,
        amount: revision.amount ? Number(revision.amount) : undefined,
        currency: revision.currency ?? "GBP",
        external_ref: externalRef,
        room_name: roomName,
        room_type: roomName,
        ota_status: revision.status,
        sending_system: "channex",
        nightly_rates: revision.rooms ?? null,
      };

  try {
    const res = await fetch(property.downstream_url as string, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();

    if (!res.ok) {
      await supabase
        .from("inbound_bookings")
        .update({ forward_error: `${res.status} ${text.slice(0, 500)}` })
        .eq("revision_id", revisionId);
      return false;
    }

    let payload: { token?: string; portal_url?: string; payment_link?: string | null } = {};
    try { payload = JSON.parse(text); } catch {}

    await supabase
      .from("inbound_bookings")
      .update({
        forwarded_at: new Date().toISOString(),
        forward_error: null,
        portal_token: payload.token ?? null,
        portal_url: payload.portal_url ?? null,
        payment_link: payload.payment_link ?? null,
      })
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


/* -------------------------------------------------------------------------- */
/* Direct-forward flow (hub -> portal direct, then booking.filed -> YFD)       */
/*                                                                            */
/* Used only when property.use_direct_forward is true. It fixes gaps 1, 2 and  */
/* the hub half of gap 3: every apartment of a multi-room reservation is       */
/* forwarded (not just rooms[0]); a durable per-room assignment means a modify  */
/* never re-picks a flat; and a dropped room is cancelled explicitly rather     */
/* than silently reopened. Matches the contract field names exactly.           */
/* -------------------------------------------------------------------------- */

type PortalBookingResponse = {
  booking_id?: string | null;
  room?: string | null;
  room_key?: string | null;
  token?: string | null;
  portal_url?: string | null;
  status?: string | null;
};

type DeactivatedRoom = { booking_id: string | null; room: string | null; room_key: string | null };

/** Occupancy as a tuple, for a stable tie-break. */
function roomOccupancy(room: BookingRoom): [number, number, number] {
  const o = room.occupancy ?? {};
  return [o.adults ?? 0, o.children ?? 0, o.infants ?? 0];
}

/**
 * Deterministic order for rooms of the same type: earliest check-in, then
 * check-out, then occupancy. This is how the ordinal is assigned at first sight
 * and how incoming rooms are ordered when mapped back to stored keys.
 */
function compareRooms(a: BookingRoom, b: BookingRoom): number {
  if (a.checkin_date !== b.checkin_date) return a.checkin_date < b.checkin_date ? -1 : 1;
  if (a.checkout_date !== b.checkout_date) return a.checkout_date < b.checkout_date ? -1 : 1;
  const [aa, ac, ai] = roomOccupancy(a);
  const [ba, bc, bi] = roomOccupancy(b);
  if (aa !== ba) return aa - ba;
  if (ac !== bc) return ac - bc;
  return ai - bi;
}

function groupIndicesByType(rooms: BookingRoom[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  rooms.forEach((r, i) => {
    const t = r.room_type_id ?? "unknown";
    const arr = m.get(t) ?? [];
    arr.push(i);
    m.set(t, arr);
  });
  return m;
}

function parseKey(key: string): { room_type_id: string; ordinal: number } {
  const i = key.lastIndexOf("#");
  if (i < 0) return { room_type_id: key, ordinal: 0 };
  return { room_type_id: key.slice(0, i), ordinal: Number(key.slice(i + 1)) || 0 };
}

/** room_key = `${channex_room_type_id}#${ordinal}`, ordinal 1-based per type. */
function assignFreshKeys(rooms: BookingRoom[]): string[] {
  const keys: string[] = new Array(rooms.length);
  for (const [typeId, idxs] of groupIndicesByType(rooms)) {
    const sorted = [...idxs].sort((a, b) => compareRooms(rooms[a], rooms[b]));
    sorted.forEach((idx, ord) => {
      keys[idx] = `${typeId}#${ord + 1}`;
    });
  }
  return keys;
}

/**
 * Map the rooms of a later revision onto the keys we already assigned, WITHOUT
 * recomputing any ordinal. Same type first (in date order), then any surviving
 * cross-type slot (a room type change), then genuinely new rooms get a fresh
 * ordinal past the highest already seen. Stored keys that no incoming room
 * claims have dropped out and are returned for an explicit cancel.
 *
 * Note: room_assignments does not persist dates, so "nearest dates" within a
 * type degrades to the same stable (checkin, checkout, occupancy) order used at
 * first sight. For the common case (N rooms of one type over the same nights)
 * this is exact; the reshuffle risk the contract already flags (a sub-room date
 * change among same-type rooms) is unchanged by this.
 */
function matchStoredKeys(
  rooms: BookingRoom[],
  stored: { room_key: string; apartment: string | null }[],
): { keys: string[]; reassign: boolean[]; droppedKeys: { room_key: string; apartment: string | null }[] } {
  const keys: string[] = new Array(rooms.length);
  const reassign: boolean[] = new Array(rooms.length).fill(false);

  type Avail = { room_key: string; apartment: string | null; room_type_id: string; ordinal: number; used: boolean };
  const avail: Avail[] = stored.map((s) => ({ ...s, ...parseKey(s.room_key), used: false }));
  const assignedIdx = new Set<number>();

  // Pass 1: same room type, matched in deterministic date order.
  for (const [typeId, idxs] of groupIndicesByType(rooms)) {
    const sortedIdx = [...idxs].sort((a, b) => compareRooms(rooms[a], rooms[b]));
    const sameType = avail.filter((a) => a.room_type_id === typeId && !a.used).sort((a, b) => a.ordinal - b.ordinal);
    const n = Math.min(sortedIdx.length, sameType.length);
    for (let k = 0; k < n; k++) {
      keys[sortedIdx[k]] = sameType[k].room_key;
      sameType[k].used = true;
      assignedIdx.add(sortedIdx[k]);
    }
  }

  // Pass 2: cross type — a surviving slot whose room type changed.
  const remainingRooms = rooms.map((_, i) => i).filter((i) => !assignedIdx.has(i)).sort((a, b) => compareRooms(rooms[a], rooms[b]));
  const remainingKeys = avail
    .filter((a) => !a.used)
    .sort((a, b) => (a.room_type_id !== b.room_type_id ? a.room_type_id.localeCompare(b.room_type_id) : a.ordinal - b.ordinal));
  let kk = 0;
  for (const i of remainingRooms) {
    if (kk >= remainingKeys.length) break;
    const key = remainingKeys[kk++];
    keys[i] = key.room_key;
    key.used = true;
    reassign[i] = true;
    assignedIdx.add(i);
  }

  // Pass 3: genuinely new rooms — a fresh ordinal past the highest seen, so no
  // existing ordinal is ever recomputed.
  const maxOrdinal = new Map<string, number>();
  for (const a of avail) maxOrdinal.set(a.room_type_id, Math.max(maxOrdinal.get(a.room_type_id) ?? 0, a.ordinal));
  for (const key of keys) {
    if (!key) continue;
    const { room_type_id, ordinal } = parseKey(key);
    maxOrdinal.set(room_type_id, Math.max(maxOrdinal.get(room_type_id) ?? 0, ordinal));
  }
  for (let i = 0; i < rooms.length; i++) {
    if (assignedIdx.has(i)) continue;
    const typeId = rooms[i].room_type_id ?? "unknown";
    const next = (maxOrdinal.get(typeId) ?? 0) + 1;
    maxOrdinal.set(typeId, next);
    keys[i] = `${typeId}#${next}`;
    assignedIdx.add(i);
  }

  const droppedKeys = avail.filter((a) => !a.used).map((a) => ({ room_key: a.room_key, apartment: a.apartment }));
  return { keys, reassign, droppedKeys };
}

/** channex_room_type_id -> { name, apartments } for candidate lists and names. */
async function loadRoomTypeIndex(propertyId: string): Promise<Map<string, { name: string; apartments: string[] }>> {
  const { data } = await db().from("room_types").select("name, channex_room_type_id, apartments").eq("property_id", propertyId);
  const map = new Map<string, { name: string; apartments: string[] }>();
  for (const rt of data ?? []) {
    if (rt.channex_room_type_id) {
      map.set(rt.channex_room_type_id as string, {
        name: (rt.name as string) ?? "",
        apartments: (rt.apartments as string[] | null) ?? [],
      });
    }
  }
  return map;
}

async function recordForwardError(revisionId: string | undefined, message: string): Promise<void> {
  await db().from("inbound_bookings").update({ forward_error: message.slice(0, 500) }).eq("revision_id", revisionId);
}

/** booking.filed to the YourFrontDesk channex-webhook. Errors are collected, not thrown. */
async function postBookingFiled(url: string, secret: string, body: Record<string, unknown>, errors: string[]): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-channex-webhook-secret": secret },
      body: JSON.stringify(body),
    });
    if (!res.ok) errors.push(`yfd booking.filed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    errors.push(`yfd booking.filed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const guestOf = (revision: BookingRevision) => ({
  first_name: revision.customer?.name ?? "Guest",
  last_name: revision.customer?.surname ?? (revision.ota_name ?? "Booking"),
  email: revision.customer?.mail ?? "",
  phone: revision.customer?.phone ?? "",
});

/**
 * The new flow: one call per apartment to the portal under the same
 * external_ref, each returning the apartment the portal picked, then one
 * booking.filed to YFD per apartment. Availability has already been applied by
 * ingestRevision; this only owns the handover.
 */
async function forwardDirect(property: Property, revision: BookingRevision): Promise<boolean> {
  const supabase = db();
  const revisionId = revision.id ?? revision.revision_id;
  const status = String(revision.status).toLowerCase();
  const externalRef = externalRefFor(revision, revisionId);

  // Claim the revision before any work. The webhook, the 15-minute poll and the
  // retry cron can all reach here for the same revision at once; two concurrent
  // first-time POSTs for the same new room_key can orphan a guest row. The
  // conditional UPDATE is atomic at the row level: whoever it affects holds the
  // claim, everyone else gets no row back and returns quietly. The 5-minute
  // window lets a crashed forward be re-claimed.
  const claimBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: claimed } = await supabase
    .from("inbound_bookings")
    .update({ forward_claimed_at: new Date().toISOString() })
    .eq("revision_id", revisionId)
    .or(`forward_claimed_at.is.null,forward_claimed_at.lt.${claimBefore}`)
    .select("id");
  if (!claimed || claimed.length === 0) return false;

  const portalBase = process.env.PORTAL_API_URL?.replace(/\/$/, "");
  const portalKey = process.env.PORTAL_API_KEY;
  if (!portalBase || !portalKey) {
    await recordForwardError(revisionId, "PORTAL_API_URL or PORTAL_API_KEY is not set");
    return false;
  }
  const portalUrl = `${portalBase}/api/external/bookings`;
  // Preview deployments of the portal sit behind Vercel deployment protection.
  // When PORTAL_PREVIEW_BYPASS is set (staging rehearsal only) every portal
  // fetch carries the Protection Bypass for Automation header; unset in
  // production, so the header is never added there and the live path is
  // unaffected. authHeaders is used by every portal fetch in forwardDirect and
  // is passed through to forwardDirectCancel, so this one place covers them all.
  const previewBypass = process.env.PORTAL_PREVIEW_BYPASS;
  const authHeaders: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${portalKey}`,
    ...(previewBypass ? { "x-vercel-protection-bypass": previewBypass } : {}),
  };

  // booking.filed is sent to the YFD channex-webhook named by downstream_url,
  // authenticated with the property's downstream secret.
  const { data: propRow } = await supabase.from("properties").select("downstream_secret").eq("id", property.id).single();
  const downstreamSecret = (propRow?.downstream_secret as string | null) ?? null;
  const filedUrl = property.downstream_url as string;

  if (status === "cancelled") {
    return forwardDirectCancel(property, revision, externalRef, revisionId, portalUrl, authHeaders, filedUrl, downstreamSecret);
  }

  const rooms = revision.rooms ?? [];
  if (rooms.length === 0) {
    await recordForwardError(revisionId, "Revision carries no rooms to forward");
    return false;
  }

  const typeIndex = await loadRoomTypeIndex(property.id);

  const { data: storedRows } = await supabase.from("room_assignments").select("room_key, apartment").eq("external_ref", externalRef);
  const stored = (storedRows ?? []).map((r) => ({ room_key: r.room_key as string, apartment: (r.apartment as string | null) ?? null }));

  const assigned = stored.length
    ? matchStoredKeys(rooms, stored)
    : { keys: assignFreshKeys(rooms), reassign: rooms.map(() => false), droppedKeys: [] as { room_key: string; apartment: string | null }[] };

  const filedStatus = status === "modified" ? "modified" : "new";
  const unitsBooked = rooms.length;
  const currency = revision.currency ?? "GBP";
  const pc = String(revision.payment_collect ?? "").toLowerCase();
  // Only channels known to collect the FULL stay up front may mark the share
  // paid in full. Booking.com "Payments by Booking.com" may be a deposit only,
  // so any other 'ota' case is sent as null (the portal treats it as balance
  // due) rather than over-marking a partial prepayment as fully paid.
  const otaName = String(revision.ota_name ?? "").toLowerCase();
  const fullPrepayChannel = ["expedia", "airbnb", "hotelbeds"].some((c) => otaName.includes(c));
  const guest = guestOf(revision);
  // Channels Channex messaging does not cover cannot be reached by Charlotte, so
  // the portal must send the portal link directly and at once rather than wait on
  // a thread. Hotelbeds, Agoda and Expedia EPS have no Channex thread; ota_name is
  // the marker. If EPS ever arrives indistinguishable from ordinary Expedia this
  // will miss it, so confirm the real ota_name on the first EPS booking.
  const otaLower = String(revision.ota_name ?? "").toLowerCase();
  const noThread = ["hotelbeds", "agoda", "expedia partner", "eps"].some((n) => otaLower.includes(n));

  const errors: string[] = [];
  const filedBodies: Record<string, unknown>[] = [];

  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const roomKey = assigned.keys[i];
    const reassign = assigned.reassign[i];
    const storedApt = stored.find((s) => s.room_key === roomKey)?.apartment ?? null;
    const typeInfo = room.room_type_id ? typeIndex.get(room.room_type_id) : undefined;
    const roomTypeName = typeInfo?.name ?? null;
    const candidates = typeInfo?.apartments ?? [];

    const amountShare = room.amount != null ? Number(room.amount) : revision.amount ? Number(revision.amount) / rooms.length : null;
    // ota_paid_amount: property -> 0; ota on a full-prepay channel -> this
    // apartment's full share; any other ota (e.g. Payments-by-Booking.com) ->
    // null (balance due); otherwise 0.
    const otaPaid: number | null = pc === "property" ? 0 : pc === "ota" ? (fullPrepayChannel ? amountShare ?? null : null) : 0;
    const checkIn = room.checkin_date ?? revision.arrival_date;
    const checkOut = room.checkout_date ?? revision.departure_date;

    const portalBody = {
      external_ref: externalRef,
      revision_id: revisionId,
      hub_property_id: property.id,
      room_key: roomKey,
      units_booked: unitsBooked,
      check_in: checkIn,
      check_out: checkOut,
      guest,
      amount: amountShare,
      currency,
      // source "channex" so the portal skips minting a payment link on the
      // request path (contract); channel carries the real OTA name.
      source: "channex",
      channel: revision.ota_name ?? null,
      room_type: roomTypeName,
      nightly_rates: room.days ?? null,
      payment_collect: revision.payment_collect ?? null,
      payment_type: revision.payment_type ?? null,
      ota_paid_amount: otaPaid,
      reassign,
      candidates,
      no_thread: noThread,
    };

    let portalRoom = storedApt;
    let bookingId: string | null = null;
    let token: string | null = null;
    let portalLink: string | null = null;

    try {
      const res = await fetch(portalUrl, { method: "POST", headers: authHeaders, body: JSON.stringify(portalBody) });
      const text = await res.text();
      if (!res.ok) {
        errors.push(`portal ${roomKey}: ${res.status} ${text.slice(0, 200)}`);
        continue;
      }
      let p: PortalBookingResponse = {};
      try {
        p = JSON.parse(text) as PortalBookingResponse;
      } catch {}
      portalRoom = p.room ?? storedApt;
      bookingId = p.booking_id ?? null;
      token = p.token ?? null;
      portalLink = p.portal_url ?? null;
    } catch (e) {
      errors.push(`portal ${roomKey}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Persist (or refresh) the durable assignment. revision_id records which
    // revision last wrote it; apartment keeps the last apartment the portal held.
    await supabase
      .from("room_assignments")
      .upsert(
        { external_ref: externalRef, room_key: roomKey, apartment: portalRoom ?? storedApt ?? null, revision_id: revisionId },
        { onConflict: "external_ref,room_key" },
      );

    filedBodies.push({
      event: "booking.filed",
      status: filedStatus,
      booking_kind: "guest",
      external_ref: externalRef,
      revision_id: revisionId,
      hub_property_id: property.id,
      room: portalRoom,
      room_key: roomKey,
      units_booked: unitsBooked,
      booking_id: bookingId,
      token,
      portal_url: portalLink,
      guest,
      check_in: checkIn,
      check_out: checkOut,
      amount: amountShare,
      currency,
      source: revision.ota_name ?? null,
      ota_paid_amount: otaPaid,
      no_thread: noThread,
    });
  }

  // booking.filed to YFD for every apartment the portal accepted.
  if (downstreamSecret) {
    for (const body of filedBodies) await postBookingFiled(filedUrl, downstreamSecret, body, errors);
  } else if (filedBodies.length) {
    errors.push("No downstream secret set; booking.filed not sent to YourFrontDesk");
  }

  // Explicit cancels for any stored key that dropped out of this revision, so a
  // removed room is deactivated rather than silently reopened.
  if (assigned.droppedKeys.length) {
    const cancelledRooms: DeactivatedRoom[] = [];
    for (const dk of assigned.droppedKeys) {
      try {
        const res = await fetch(portalUrl, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ status: "cancelled", external_ref: externalRef, room_key: dk.room_key }),
        });
        if (!res.ok) errors.push(`portal drop ${dk.room_key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      } catch (e) {
        errors.push(`portal drop ${dk.room_key}: ${e instanceof Error ? e.message : String(e)}`);
      }
      cancelledRooms.push({ booking_id: null, room: dk.apartment, room_key: dk.room_key });
    }
    if (downstreamSecret && cancelledRooms.length) {
      await postBookingFiled(
        filedUrl,
        downstreamSecret,
        { event: "booking.filed", status: "cancelled", external_ref: externalRef, revision_id: revisionId, hub_property_id: property.id, rooms: cancelledRooms },
        errors,
      );
    }
  }

  if (errors.length) {
    await recordForwardError(revisionId, errors.join(" | "));
    return false;
  }
  await supabase.from("inbound_bookings").update({ forwarded_at: new Date().toISOString(), forward_error: null }).eq("revision_id", revisionId);
  return true;
}

/**
 * A whole-reference cancellation. The portal deactivates every active row for
 * the ref and returns the rooms it deactivated; the hub forwards those to YFD
 * as a cancel booking.filed. Idempotent: deactivating already-cancelled rows is
 * a no-op, so the retry cron can re-run a failed cancel safely.
 */
async function forwardDirectCancel(
  property: Property,
  revision: BookingRevision,
  externalRef: string,
  revisionId: string | undefined,
  portalUrl: string,
  authHeaders: Record<string, string>,
  filedUrl: string,
  downstreamSecret: string | null,
): Promise<boolean> {
  const supabase = db();
  const errors: string[] = [];
  let deactivated: DeactivatedRoom[] = [];

  try {
    const res = await fetch(portalUrl, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ status: "cancelled", external_ref: externalRef }),
    });
    const text = await res.text();
    if (!res.ok) {
      errors.push(`portal cancel: ${res.status} ${text.slice(0, 200)}`);
    } else {
      // The portal returns the deactivated rows as `rooms` (an alias of
      // `cancelled_rows`); empty [] with not_found:true means nothing matched.
      let p: { rooms?: DeactivatedRoom[]; cancelled_rows?: DeactivatedRoom[] } = {};
      try {
        p = JSON.parse(text) as { rooms?: DeactivatedRoom[]; cancelled_rows?: DeactivatedRoom[] };
      } catch {}
      const list = Array.isArray(p.rooms) ? p.rooms : Array.isArray(p.cancelled_rows) ? p.cancelled_rows : null;
      if (list) {
        deactivated = list.map((r) => ({ booking_id: r.booking_id ?? null, room: r.room ?? null, room_key: r.room_key ?? null }));
      }
    }
  } catch (e) {
    errors.push(`portal cancel: ${e instanceof Error ? e.message : String(e)}`);
  }

  // If the portal did not echo the deactivated rooms, fall back to the hub's own
  // record of the reference's apartments.
  if (!deactivated.length) {
    const { data: storedRows } = await supabase.from("room_assignments").select("room_key, apartment").eq("external_ref", externalRef);
    deactivated = (storedRows ?? []).map((r) => ({ booking_id: null, room: (r.apartment as string | null) ?? null, room_key: r.room_key as string }));
  }

  if (downstreamSecret) {
    await postBookingFiled(
      filedUrl,
      downstreamSecret,
      { event: "booking.filed", status: "cancelled", external_ref: externalRef, revision_id: revisionId, hub_property_id: property.id, rooms: deactivated },
      errors,
    );
  } else {
    errors.push("No downstream secret set; cancel booking.filed not sent to YourFrontDesk");
  }

  if (errors.length) {
    await recordForwardError(revisionId, errors.join(" | "));
    return false;
  }
  await supabase.from("inbound_bookings").update({ forwarded_at: new Date().toISOString(), forward_error: null }).eq("revision_id", revisionId);
  return true;
}

export type RetryResult = { pending: number; retried: number; succeeded: number; failed: number; errors: string[] };

/**
 * Bookings that reached us but never reached the portal.
 *
 * Once a revision is acknowledged, Channex will not offer it again: the feed
 * only holds what is unacknowledged and the webhook fires once. So without this,
 * a portal that was down for ten minutes means a guest who never receives a
 * link, silently, forever. Nothing else in the system would have noticed.
 */
export async function retryUnforwarded(limit = 20): Promise<RetryResult> {
  const supabase = db();
  const result: RetryResult = { pending: 0, retried: 0, succeeded: 0, failed: 0, errors: [] };

  // Everything before the production cutover belongs to certification: staging
  // test hotels, invented guests, dates in the past. None of it is a real
  // reservation and none of it may reach a live guest portal. The first run of
  // this retry pushed one of them through before this guard existed.
  const { data: cutoverRow } = await supabase.from("hub_config").select("value").eq("key", "forward_cutover_at").maybeSingle();
  const cutover = (cutoverRow?.value as string) ?? new Date().toISOString();

  // Cancellations are retried the same as any other event (gap 3 / item 4). A
  // failed cancel forward leaves forwarded_at null and forward_error set, so it
  // is picked up here like a failed new or modify. forwardDownstream /
  // forwardDirect are idempotent on a re-send, so retrying a cancel is safe.
  const { data: stuck, error } = await supabase
    .from("inbound_bookings")
    .select("id, property_id, payload, status, received_at")
    .is("forwarded_at", null)
    .not("property_id", "is", null)
    .gte("received_at", cutover)
    .order("received_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Reading unforwarded bookings: ${error.message}`);

  result.pending = stuck?.length ?? 0;

  for (const row of stuck ?? []) {
    const { data: propertyRow } = await supabase
      .from("properties")
      .select("*")
      .eq("id", row.property_id as string)
      .maybeSingle();
    const property = propertyRow as Property | null;
    if (!property?.downstream_url || !property.is_active) continue;

    result.retried++;
    const ok = await forwardDownstream(property, row.payload as BookingRevision);
    if (ok) result.succeeded++;
    else {
      result.failed++;
      const { data: after } = await supabase
        .from("inbound_bookings")
        .select("forward_error")
        .eq("id", row.id as string)
        .maybeSingle();
      if (after?.forward_error) result.errors.push(after.forward_error as string);
    }
  }

  return result;
}
