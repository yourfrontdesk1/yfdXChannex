import { NextResponse } from "next/server";
import { guard } from "@/lib/session";
import { auditListings } from "@/lib/audit";
import { runJob } from "@/lib/ops";
import { db } from "@/lib/db";
import type { AuditCheck } from "@/lib/audit";

async function emailProblems(failed: AuditCheck[]): Promise<void> {
  const { data: p } = await db()
    .from("properties")
    .select("downstream_url, downstream_secret")
    .not("downstream_url", "is", null)
    .limit(1)
    .maybeSingle();
  if (!p?.downstream_url || !p.downstream_secret) return;
  await fetch((p.downstream_url as string).replace(/channex-webhook\/?$/, "system-alert"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-channex-webhook-secret": p.downstream_secret as string },
    body: JSON.stringify({
      problems: failed.map((c) => ({
        key: `audit:${c.property}:${c.check}`,
        title: `${c.property}: ${c.check}`,
        lines: [c.detail, "Found by the hourly audit of the Booking.com listings."],
      })),
    }),
  }).catch(() => null);
}

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
        // Leon is emailed about every failing check, once and then every few
        // hours while it lasts, through YourFrontDesk's mailbox.
        if (out.failed) await emailProblems(out.checks.filter((c) => !c.ok));
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
