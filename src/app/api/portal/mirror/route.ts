import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { mirrorPortalBookings } from "@/lib/portalMirror";
import { record } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Every 15 minutes. See src/lib/portalMirror.ts. */
async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const started = Date.now();
  try {
    const out = await mirrorPortalBookings();
    // A run with rows YourFrontDesk would not take is a failed run, and the row
    // is named here. It used to record ok with inserted 0, which hid a stopped
    // sweep for two days.
    await record("portal-mirror", started, out.errors.length === 0, out, out.errors.length ? out.errors.slice(0, 5).join("; ") : undefined);
    return NextResponse.json(out);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await record("portal-mirror", started, false, null, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
export const GET = run;
export const POST = run;
