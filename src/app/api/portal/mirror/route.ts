import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { mirrorPortalBookings } from "@/lib/portalMirror";
import { runJob } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Every 15 minutes. See src/lib/portalMirror.ts. */
async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    return NextResponse.json(await runJob("portal-mirror", mirrorPortalBookings));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
export const GET = run;
export const POST = run;
