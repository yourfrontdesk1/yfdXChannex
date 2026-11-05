import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { enabled } from "@/lib/ops";
import { markRatesDirty } from "@/lib/channexRateFollow";

export const dynamic = "force-dynamic";

/**
 * Channex's ari event, registered on its own webhook. Only marks dates dirty, see
 * src/lib/channexRateFollow.ts. Answered 200 even on a failure, because a 5xx puts
 * Channex into eleven retries over a day for an event that is only a nudge.
 */
export async function POST(request: Request) {
  if (!authorised(request, "CHANNEX_WEBHOOK_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  let body: { event?: string; property_id?: string; user_id?: string | null; payload?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true, note: "Body was not JSON, nothing to do" });
  }
  if (body.event !== "ari") return NextResponse.json({ ok: true, note: `Nothing to do for ${body.event ?? "an event with no name"}` });
  if (!(await enabled("channex_rate_follow"))) return NextResponse.json({ ok: true, note: "Switched off" });
  try {
    return NextResponse.json({ ok: true, ...(await markRatesDirty(body)) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
