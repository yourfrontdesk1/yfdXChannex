import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { flushProperty } from "@/lib/outbox";
import { guard } from "@/lib/session";
import { applyEffectChange, nightsEffect, type Effect } from "@/lib/holds";
import type { Property } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Bookings made in the PMS. Creating one takes its nights out of availability,
 * moving it releases the old nights and takes the new ones, cancelling releases
 * everything. Each of those is one write to the ARI store for the affected
 * dates only, which the trigger turns into deltas and the outbox sends as a
 * single availability call.
 */

type PmsBooking = {
  id: string;
  property_id: string;
  room_type_id: string;
  guest_name: string | null;
  checkin: string;
  checkout: string;
  rooms: number;
  status: "confirmed" | "cancelled";
  applied_effect: Effect | null;
  created_at: string;
  updated_at: string;
};

type Body = {
  action?: "create" | "move" | "cancel";
  property_id?: string;
  id?: string;
  room_type_id?: string;
  guest_name?: string;
  checkin?: string;
  checkout?: string;
  rooms?: number;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const propertyId = new URL(request.url).searchParams.get("property");
  if (!propertyId) return NextResponse.json({ error: "property is required" }, { status: 400 });

  const { data, error } = await db()
    .from("bookings")
    .select("*")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ bookings: (data ?? []) as PmsBooking[] });
}

export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Body was not valid JSON" }, { status: 400 });
  }

  const supabase = db();
  const action = body.action ?? "create";

  if (action === "create") {
    const { property_id, room_type_id, checkin, checkout } = body;
    if (!property_id || !room_type_id) return NextResponse.json({ error: "property_id and room_type_id are required" }, { status: 400 });
    const bad = validateDates(checkin, checkout);
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });

    const { data: propertyRow } = await supabase.from("properties").select("*").eq("id", property_id).maybeSingle();
    const property = propertyRow as Property | null;
    if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

    const { data: roomType } = await supabase
      .from("room_types")
      .select("id")
      .eq("id", room_type_id)
      .eq("property_id", property_id)
      .maybeSingle();
    if (!roomType) return NextResponse.json({ error: "That room type does not belong to this property" }, { status: 400 });

    const rooms = Math.max(1, Math.floor(Number(body.rooms ?? 1)));
    const { data: inserted, error } = await supabase
      .from("bookings")
      .insert({
        property_id,
        room_type_id,
        guest_name: body.guest_name?.trim() || null,
        checkin,
        checkout,
        rooms,
        status: "confirmed",
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const booking = inserted as PmsBooking;

    const effect = nightsEffect(room_type_id, checkin as string, checkout as string, rooms);
    const applied = await applyEffectChange(property, {}, effect);
    await supabase.from("bookings").update({ applied_effect: effect, updated_at: new Date().toISOString() }).eq("id", booking.id);

    const calls = await flush(property.id);
    return NextResponse.json({ booking: { ...booking, applied_effect: effect }, availability: applied, calls });
  }

  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const { data: existingRow } = await supabase.from("bookings").select("*").eq("id", body.id).maybeSingle();
  const existing = existingRow as PmsBooking | null;
  if (!existing) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const { data: propertyRow } = await supabase.from("properties").select("*").eq("id", existing.property_id).maybeSingle();
  const property = propertyRow as Property | null;
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  const prior = existing.status === "cancelled" ? {} : (existing.applied_effect ?? {});

  if (action === "move") {
    if (existing.status === "cancelled") return NextResponse.json({ error: "A cancelled booking cannot be moved" }, { status: 400 });
    const checkin = body.checkin ?? existing.checkin;
    const checkout = body.checkout ?? existing.checkout;
    const bad = validateDates(checkin, checkout);
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });

    const next = nightsEffect(existing.room_type_id, checkin, checkout, existing.rooms);
    const applied = await applyEffectChange(property, prior, next);
    const { data: updated } = await supabase
      .from("bookings")
      .update({ checkin, checkout, applied_effect: next, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select()
      .single();

    const calls = await flush(property.id);
    return NextResponse.json({ booking: updated, availability: applied, calls });
  }

  if (action === "cancel") {
    const applied = await applyEffectChange(property, prior, {});
    const { data: updated } = await supabase
      .from("bookings")
      .update({ status: "cancelled", applied_effect: {}, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select()
      .single();

    const calls = await flush(property.id);
    return NextResponse.json({ booking: updated, availability: applied, calls });
  }

  return NextResponse.json({ error: `Unknown action ${String(action)}` }, { status: 400 });
}

function validateDates(checkin?: string, checkout?: string): string | null {
  if (!checkin || !checkout || !DATE.test(checkin) || !DATE.test(checkout)) return "checkin and checkout must be YYYY-MM-DD";
  if (checkout <= checkin) return "checkout must be after checkin";
  return null;
}

/**
 * Same as the grid: the delta still goes trigger, outbox, batched call. Draining
 * here only stops it waiting for the next worker tick, and a channel manager
 * failure never fails the booking, the outbox keeps the delta for retry.
 */
async function flush(propertyId: string) {
  try {
    const report = await flushProperty(propertyId);
    return report.calls.map((c) => ({ path: c.path, values: c.values, task_id: c.task_id, ok: c.ok }));
  } catch (err) {
    console.error("[api/bookings] flush after write failed, delta stays queued:", err);
    return [];
  }
}
