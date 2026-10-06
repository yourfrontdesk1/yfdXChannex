import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { sendReminders } from "@/lib/reminders";
import { runJob, enabled } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Check in reminders, once a day at a civil hour. See src/lib/reminders.ts. */
async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    if (!(await enabled("reminders_enabled"))) return NextResponse.json({ skipped: "reminders_enabled is false in hub_config" });
    return NextResponse.json(await runJob("reminders", sendReminders));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
