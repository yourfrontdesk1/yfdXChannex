import { NextResponse } from "next/server";
import { guard } from "@/lib/session";
import { auditListings } from "@/lib/audit";
import { runJob } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Runs the listing audit. A failed check fails the job, which turns the health board red. */
async function run(request: Request) {
  const denied = await guard(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });
  try {
    return NextResponse.json(
      await runJob("audit", async () => {
        const out = await auditListings();
        if (out.failed) throw new Error(out.checks.filter((c) => !c.ok).map((c) => `${c.property}: ${c.check}: ${c.detail}`).join(" | "));
        return out;
      }),
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
