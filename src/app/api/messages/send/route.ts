import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { sendGuestMessage } from "@/lib/messages";
import { threadFor } from "@/lib/guest-link";
import { db } from "@/lib/db";
import { markPortalLinkSent } from "@/lib/portal";
import { mirrorToYourFrontDesk } from "@/lib/mirror";

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

  let body: { thread_id?: string; message?: string; external_ref?: string; no_mirror?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body was not valid JSON" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  const externalRef = (body.external_ref ?? "").trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  let threadId = (body.thread_id ?? "").trim();
  let bookingId: string | null = null;
  let channexPropertyId: string | null = null;
  if (!threadId) {
    if (!externalRef) {
      return NextResponse.json({ error: "thread_id or external_ref is required" }, { status: 400 });
    }
    const supabase = db();
    const { data: booking } = await supabase
      .from("inbound_bookings")
      .select("channex_booking_id, ota_reservation_code, property_id")
      // YourFrontDesk knows the booking as BDC-6639721282, this service stores
      // the bare number Channex sent. Match either, or a message never finds
      // its booking and the guest is answered by nobody.
      .or(`ota_reservation_code.eq.${externalRef},ota_reservation_code.eq.${externalRef.replace(/^[A-Z]{3}-/, "")}`)
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
    channexPropertyId = property?.channex_property_id as string | null;
    if (!channexPropertyId) {
      return NextResponse.json({ error: "That property is not provisioned on Channex" }, { status: 409 });
    }
    bookingId = (booking.channex_booking_id as string | null) ?? null;
    // A thread when the guest has already written; otherwise the booking itself,
    // which opens the conversation. A new booking has no thread and must still
    // get its link.
    threadId =
      (await threadFor(channexPropertyId, bookingId, (booking.ota_reservation_code as string | null) ?? externalRef)) ?? "";
  }

  const sent = await sendGuestMessage({ threadId: threadId || null, bookingId, text: message, propertyId: channexPropertyId });
  if (!sent.ok) {
    return NextResponse.json({ error: sent.error ?? "Channex refused the message" }, { status: 502 });
  }
  threadId = sent.threadId ?? threadId;

  // Record the send in the hub's own message log. Until now only auto-replies
  // wrote an outbound row, so a message composed in YourFrontDesk or sent by
  // hand left no trace here: it made Sara's delivered confirmation look missing
  // in an audit and nearly got it resent. channex_message_id is unique, so a
  // mirror of the same send back from YourFrontDesk collapses onto this row
  // rather than doubling; sender "yfd" marks where it came from. Never fatal.
  try {
    const bareRef = externalRef ? externalRef.replace(/^[A-Z]{3}-/, "") : null;
    await db().from("guest_messages").insert({
      channex_message_id: sent.messageId,
      thread_id: threadId || null,
      channex_booking_id: bookingId,
      ota_reservation_code: bareRef,
      direction: "outbound",
      sender: "yfd",
      body: message,
      sent_at: new Date().toISOString(),
      forwarded_at: new Date().toISOString(),
    });
  } catch {
    // The message is sent; a missing log row must not fail the send.
  }

  // Stamped here rather than in YourFrontDesk, because this is the moment it
  // actually left. A booking whose link was sent twice is a guest who thinks
  // something went wrong.
  if (externalRef) {
    await db()
      .from("inbound_bookings")
      .update({ link_sent_at: new Date().toISOString() })
      .or(`ota_reservation_code.eq.${externalRef},ota_reservation_code.eq.${externalRef.replace(/^[A-Z]{3}-/, "")}`)
      // The first send is the link. A later reply must not move the time, or a
      // reminder counts from the wrong day.
      .is("link_sent_at", null);
  }

  // And on the guest portal itself, so its own "Link sent" badge is true. The
  // portal knows the booking as BDC-6276994350 whichever way it was asked. Only
  // the first send is stamped; a later message is not a second link.
  if (externalRef) {
    const portalRef = /^[A-Z]{3}-/.test(externalRef) ? externalRef : `BDC-${externalRef}`;
    await markPortalLinkSent(portalRef).catch(() => null);
  }

  // The YourFrontDesk Inbox stores what it sends itself, so it asks for no copy.
  if (externalRef && !body.no_mirror) {
    await mirrorToYourFrontDesk({ otaReservationCode: externalRef }, { kind: "message", sender: "host", content: message });
  }

  return NextResponse.json({ ok: true, thread_id: threadId });
}
