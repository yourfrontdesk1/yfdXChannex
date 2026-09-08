import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { db } from "@/lib/db";
import { fetchRevision, ingestRevision, type BookingRevision } from "@/lib/bookings";

export const dynamic = "force-dynamic";

const BOOKING_EVENTS = new Set([
  "booking",
  "booking_new",
  "booking_modification",
  "booking_cancellation",
  "non_acked_booking",
  "booking_unmapped_room",
  "booking_unmapped_rate",
]);

/**
 * Channex send a notification carrying the booking and revision ids, not the
 * booking itself, and they say plainly that the calls can arrive out of order.
 * So the revision is fetched by id exactly once per revision: one already
 * stored and acknowledged is answered without touching Channex, so a repeated
 * delivery of the same event costs nothing. The webhook is registered on the
 * three booking events only, never on "*", because the wildcard fires the
 * generic booking event as well and every revision was being pulled twice.
 * Should a body ever carry the full revision, it is used as delivered.
 *
 * A 5xx from this endpoint puts Channex into eleven retries over a day, so an
 * ingest failure is answered 200 with the problem in the body and picked up by
 * the feed poller, which runs every fifteen minutes as the backup.
 */
export async function POST(request: Request) {
  if (!authorised(request, "CHANNEX_WEBHOOK_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: {
    event?: string;
    property_id?: string;
    payload?: Partial<BookingRevision> & { revision_id?: string; booking_revision_id?: string; booking_id?: string };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true, note: "Body was not JSON, nothing to do" });
  }

  const event = body.event ?? "";
  if (!BOOKING_EVENTS.has(event)) {
    return NextResponse.json({ ok: true, note: `Nothing to do for ${event || "an event with no name"}` });
  }

  const payload = body.payload;
  const revisionId = payload?.revision_id ?? payload?.booking_revision_id ?? payload?.id;
  if (!revisionId) {
    return NextResponse.json({ ok: true, note: "Event carried no revision id" });
  }

  try {
    // Already stored: a repeat delivery of the same revision needs no work.
    const { data: existing } = await db()
      .from("inbound_bookings")
      .select("id, acknowledged_at")
      .eq("revision_id", revisionId)
      .maybeSingle();
    if (existing?.acknowledged_at) {
      return NextResponse.json({ ok: true, event, note: "Revision already stored and acknowledged" });
    }

    // With send_data the body is the revision. Only a body without one is fetched.
    const delivered = payload && typeof payload.status === "string" && typeof payload.property_id === "string" && payload.arrival_date;
    const revision = delivered
      ? ({ ...payload, id: payload.id ?? revisionId } as BookingRevision)
      : await fetchRevision(revisionId);
    if (!revision) {
      return NextResponse.json({ ok: true, note: "Revision could not be pulled, the feed will retry it" });
    }
    const result = await ingestRevision(revision);
    return NextResponse.json({ ok: true, event, source: delivered ? "webhook body" : "fetched by id", result });
  } catch (e) {
    return NextResponse.json({
      ok: true,
      event,
      error: e instanceof Error ? e.message : String(e),
      note: "Left for the feed poller rather than answered with a 500",
    });
  }
}
