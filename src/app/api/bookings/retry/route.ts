import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { retryUnforwarded } from "@/lib/bookings";
import { runJob } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The safety net under the handover to the guest portal. Channex offers a
 * revision once, so anything that failed on the way downstream has to be picked
 * up here or not at all.
 */
async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runJob("retry-forward", () => retryUnforwarded()));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
