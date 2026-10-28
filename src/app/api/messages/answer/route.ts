import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { answerPendingMessages } from "@/lib/reply";
import { runJob, enabled } from "@/lib/ops";

export const dynamic = "force-dynamic";
// A technical failure of channex-reply is now retried with a 20s then 60s
// backoff, so a single message can take over a minute. The run carries a
// deadline a little under this and leaves the rest for the next tick, so the
// function fits the window even on a downstream outage.
export const maxDuration = 300;

async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    if (!(await enabled("auto_reply_enabled"))) {
      return NextResponse.json({ skipped: "auto_reply_enabled is false in hub_config" });
    }
    return NextResponse.json(await runJob("answer-messages", answerPendingMessages));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
