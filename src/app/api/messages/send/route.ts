import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { channexRequest } from "@/lib/channex";
import { threadFor } from "@/lib/guest-link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Delivers a message YourFrontDesk has written.
 *
 * The Booking.com thread for this listing is reachable only through Channex, and
 * only this service holds the Channex key. So the words are decided in
 * YourFrontDesk, which owns the guest, and posted here. This endpoint carries no
 * opinion about what should be said; it is the pipe.
 *
 * Body: { message, external_ref, thread_id? }
 *
 * The thread is resolved here when it is not supplied, because YourFrontDesk
 * knows the booking reference and has no way to know Channex's thread id.
 */
export async function POST(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { thread_id?: string; message?: string; external_ref?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body was not valid JSON" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  const externalRef = (body.external_ref ?? "").trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  let threadId = (body.thread_id ?? "").trim();
  if (!threadId) {
    if (!externalRef) {
      return NextResponse.json({ error: "thread_id or external_ref is required" }, { status: 400 });
    }
    const supabase = db();
    const { data: booking } = await supabase
      .from("inbound_bookings")
      .select("channex_booking_id, ota_reservation_code, property_id")
      .eq("ota_reservation_code", externalRef)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!booking) {
      return NextResponse.json({ error: `No booking here for ${externalRef}` }, { status: 404 });
    }
    const { data: property } = await supabase
      .from("properties")
      .select("channex_property_id")
      .eq("id", booking.property_id as string)
      .maybeSingle();
    const channexPropertyId = property?.channex_property_id as string | null;
    if (!channexPropertyId) {
      return NextResponse.json({ error: "That property is not provisioned on Channex" }, { status: 409 });
    }
    // A booking made before the guest ever wrote has no thread yet. That is a
    // wait, not a failure, so the caller is told plainly rather than shown an error.
    const found = await threadFor(
      channexPropertyId,
      (booking.channex_booking_id as string | null) ?? null,
      (booking.ota_reservation_code as string | null) ?? externalRef,
    );
    if (!found) return NextResponse.json({ ok: false, reason: "no_thread" }, { status: 200 });
    threadId = found;
  }

  const res = await channexRequest("POST", `/message_threads/${threadId}/messages`, { message });
  if (!res.ok) {
    return NextResponse.json({ error: res.error ?? "Channex refused the message" }, { status: 502 });
  }

  // Stamped here rather than in YourFrontDesk, because this is the moment it
  // actually left. A booking whose link was sent twice is a guest who thinks
  // something went wrong.
  if (externalRef) {
    await db()
      .from("inbound_bookings")
      .update({ link_sent_at: new Date().toISOString() })
      .eq("ota_reservation_code", externalRef);
  }

  return NextResponse.json({ ok: true, thread_id: threadId });
}
