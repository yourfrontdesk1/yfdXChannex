import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { db } from "@/lib/db";
import { fetchFeed, ingestRevision } from "@/lib/bookings";
import { runJob } from "@/lib/ops";

export const dynamic = "force-dynamic";
// The feed can hold hundreds after a pull, and each revision forwards to the
// portal and files to YourFrontDesk, so one run needs well over a minute to
// drain a backlog. 300s is the plan's ceiling on the default runtime.
export const maxDuration = 300;

/**
 * The recovery path. Webhooks are the primary route in, but the feed only ever
 * holds what was never acknowledged, so draining it catches anything a missed
 * delivery left behind.
 */
async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const propertyId = new URL(request.url).searchParams.get("property");
  let channexPropertyId: string | null = null;
  if (propertyId) {
    const { data } = await db().from("properties").select("channex_property_id").eq("id", propertyId).maybeSingle();
    channexPropertyId = (data?.channex_property_id as string | null) ?? null;
  }

  try {
    const out = await runJob("bookings-poll", async () => {
      const revisions = await fetchFeed(channexPropertyId);
      const results = [];
      for (const revision of revisions) results.push(await ingestRevision(revision));
      return { found: revisions.length, results };
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
