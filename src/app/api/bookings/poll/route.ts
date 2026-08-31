import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { db } from "@/lib/db";
import { fetchFeed, ingestRevision } from "@/lib/bookings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    const revisions = await fetchFeed(channexPropertyId);
    const results = [];
    for (const revision of revisions) results.push(await ingestRevision(revision));
    return NextResponse.json({ found: revisions.length, results });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
