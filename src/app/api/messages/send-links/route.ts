import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { sendPendingGuestLinks } from "@/lib/guest-link";
import { runJob, enabled } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Every new booking that has a portal link and has not been sent it yet. Runs
 * on a schedule rather than at the moment of booking, because the OTA opens the
 * message thread in its own time and a booking that arrives before its thread
 * would otherwise be missed forever.
 */
async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    if (!(await enabled("auto_link_enabled"))) {
      return NextResponse.json({ skipped: "auto_link_enabled is false in hub_config" });
    }
    return NextResponse.json(await runJob("send-links", sendPendingGuestLinks));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
