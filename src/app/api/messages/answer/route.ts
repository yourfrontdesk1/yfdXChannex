import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { answerPendingMessages } from "@/lib/reply";
import { runJob, enabled } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
