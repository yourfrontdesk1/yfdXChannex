import { NextResponse } from "next/server";
import { roomsByProperty, syncAvailability } from "@/lib/parkside";
import { flushProperty } from "@/lib/outbox";
import { runJob } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The portal calls this, fire and forget, the instant a staff write lands: a
 * move, a block, a closure or a staff booking. Waiting for the 60 second worker
 * means a room the portal just blocked can still be sold on Booking.com for up
 * to a minute; this closes that window to seconds by recomputing availability
 * from the portal and flushing it to Channex inline.
 *
 * The caller abandons the request after about five seconds, so this returns a
 * 2xx as soon as the work is done (or there is nothing to do); the body is only
 * for a human reading the logs.
 *
 * A same type move changes no per type availability, so the recompute writes
 * nothing and the flush sends nothing. That is correct and cheap, not a bug.
 */

type StaffSyncBody = {
  /** The portal room_number, e.g. "6.02" or "10.17A". This is what we key on. */
  room?: string;
  /**
   * The PORTAL's apartment uuid. Useless to the hub (it is the portal's own
   * primary key, not ours), so it is ignored. Documented here so nobody wires
   * it in by mistake.
   */
  property_id?: string;
  /** check_in, exclusive of the checkout night. Accepted but not needed: syncAvailability recomputes the whole window. */
  from?: string;
  /** check_out. Accepted, not used to scope. */
  to?: string;
  reason?: "move" | "dates" | "block" | "unblock" | "staff_booking" | string;
};

/** Constant time string compare, so a wrong token leaks nothing by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorisedBearer(request: Request): boolean {
  const expected = process.env.HUB_SYNC_TOKEN;
  // Mirrors auth.ts: a missing secret is a hard fail in production, open in dev
  // so a local portal can call it without a token set.
  if (!expected) return process.env.NODE_ENV !== "production";
  const header = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  return header !== null && safeEqual(header, expected);
}

/** Which hub property sells the given portal room_number, if any. */
async function propertyOwning(room: string): Promise<string | null> {
  const all = await roomsByProperty();
  for (const [propertyId, types] of Object.entries(all)) {
    for (const rooms of Object.values(types)) {
      if (rooms.includes(room)) return propertyId;
    }
  }
  return null;
}

export async function POST(request: Request) {
  if (!authorisedBearer(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: StaffSyncBody = {};
  try {
    body = (await request.json()) as StaffSyncBody;
  } catch {
    // An empty or malformed body means nothing to resolve; say so and stop.
    return NextResponse.json({ ok: true, matched: false, note: "No JSON body" });
  }

  const room = typeof body.room === "string" ? body.room.trim() : "";
  if (!room) {
    return NextResponse.json({ ok: true, matched: false, note: "No room given" });
  }

  try {
    const propertyId = await propertyOwning(room);
    // A room we do not sell: nothing to recompute, and not an error.
    if (!propertyId) {
      return NextResponse.json({ ok: true, matched: false, room });
    }

    const { sync, flush } = await runJob("staff-sync", async () => {
      const sync = await syncAvailability(propertyId);
      const flush = await flushProperty(propertyId);
      return { sync, flush };
    });

    return NextResponse.json({
      ok: true,
      matched: true,
      room,
      property_id: propertyId,
      reason: body.reason ?? null,
      rows_changed: sync.rows_changed,
      sent: flush.sent,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
