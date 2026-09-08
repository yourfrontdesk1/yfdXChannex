import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { syncParksideAvailability } from "@/lib/parkside";
import { runJob } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Keeps the grid honest about Parkside. Availability that goes stale is how a
 * night gets sold twice, so this runs on a schedule rather than when someone
 * remembers. Writes only the nights that moved; the outbox and worker take it
 * from there.
 */
async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runJob("availability-sync", syncParksideAvailability));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
