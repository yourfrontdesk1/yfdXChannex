import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { fetchRevision, ingestRevision } from "@/lib/bookings";

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
 * Channex send a notification, not the booking, and they say plainly that the
 * calls can arrive out of order. So nothing here reads state out of the webhook
 * body beyond which revision to go and fetch.
 *
 * A 5xx from this endpoint puts Channex into eleven retries over a day, so an
 * ingest failure is answered 200 with the problem in the body and picked up by
 * the feed poller instead.
 */
export async function POST(request: Request) {
  if (!authorised(request, "CHANNEX_WEBHOOK_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: {
    event?: string;
    property_id?: string;
    payload?: { revision_id?: string; booking_revision_id?: string; booking_id?: string; property_id?: string };
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

  const revisionId = body.payload?.revision_id ?? body.payload?.booking_revision_id;
  if (!revisionId) {
    return NextResponse.json({ ok: true, note: "Event carried no revision id" });
  }

  try {
    const revision = await fetchRevision(revisionId);
    if (!revision) {
      return NextResponse.json({ ok: true, note: "Revision could not be pulled, the feed will retry it" });
    }
    const result = await ingestRevision(revision);
    return NextResponse.json({ ok: true, event, result });
  } catch (e) {
    return NextResponse.json({
      ok: true,
      event,
      error: e instanceof Error ? e.message : String(e),
      note: "Left for the feed poller rather than answered with a 500",
    });
  }
}
