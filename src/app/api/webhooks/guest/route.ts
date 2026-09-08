import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const MESSAGE_EVENTS = new Set(["message", "message_new", "new_message", "guest_message"]);
const REVIEW_EVENTS = new Set(["review", "review_new", "new_review", "guest_review"]);

/**
 * Guest messages and reviews from the OTA, through Channex.
 *
 * Stored on arrival and nothing more. A guest asking where the door code is at
 * eleven at night must survive whatever happens downstream, so the record is
 * written first and answering is somebody else's turn. `forwarded_at` is null
 * until a reply path exists, which makes the backlog trivial to find.
 *
 * Answered 200 even on failure, as with bookings: a 5xx puts Channex into a day
 * of retries, and the problem is more useful in the body than in their queue.
 */
export async function POST(request: Request) {
  if (!authorised(request, "CHANNEX_WEBHOOK_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { event?: string; payload?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true, note: "Body was not JSON, nothing to do" });
  }

  const event = body.event ?? "";
  const payload = body.payload ?? {};
  const supabase = db();

  try {
    if (MESSAGE_EVENTS.has(event)) {
      const id = (payload.id ?? payload.message_id) as string | undefined;
      const { error } = await supabase.from("guest_messages").upsert(
        {
          channex_message_id: id ?? null,
          thread_id: (payload.thread_id ?? payload.message_thread_id ?? null) as string | null,
          channex_booking_id: (payload.booking_id ?? null) as string | null,
          ota_reservation_code: (payload.ota_reservation_code ?? null) as string | null,
          direction: (payload.direction ?? "inbound") as string,
          sender: (payload.sender ?? payload.author ?? null) as string | null,
          body: (payload.message ?? payload.body ?? payload.text ?? null) as string | null,
          sent_at: (payload.sent_at ?? payload.inserted_at ?? null) as string | null,
          raw: payload,
        },
        { onConflict: "channex_message_id" },
      );
      if (error) throw error;
      return NextResponse.json({ ok: true, event, stored: "message" });
    }

    if (REVIEW_EVENTS.has(event)) {
      const id = (payload.id ?? payload.review_id) as string | undefined;
      const { error } = await supabase.from("guest_reviews").upsert(
        {
          channex_review_id: id ?? null,
          channex_booking_id: (payload.booking_id ?? null) as string | null,
          guest_name: (payload.guest_name ?? payload.author ?? null) as string | null,
          rating: (payload.rating ?? payload.score ?? null) as number | null,
          body: (payload.body ?? payload.text ?? payload.comment ?? null) as string | null,
          raw: payload,
        },
        { onConflict: "channex_review_id" },
      );
      if (error) throw error;
      return NextResponse.json({ ok: true, event, stored: "review" });
    }

    return NextResponse.json({ ok: true, note: `Nothing to do for ${event || "an event with no name"}` });
  } catch (e) {
    return NextResponse.json({
      ok: true,
      event,
      error: e instanceof Error ? e.message : String(e),
      note: "Answered 200 so Channex does not spend a day retrying",
    });
  }
}
