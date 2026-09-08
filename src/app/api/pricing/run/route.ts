import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { priceParkside, type Horizon } from "@/lib/pricing";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const HORIZONS = new Set(["near", "mid", "far", "all"]);

/**
 * Reprices Parkside. Split by horizon because the next fortnight moves all day
 * and next summer does not, and pushing an unchanged price is churn that buys
 * nothing and spends the rate limit.
 */
async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const asked = new URL(request.url).searchParams.get("horizon") ?? "near";
  if (!HORIZONS.has(asked)) {
    return NextResponse.json({ error: `horizon must be one of near, mid, far, all` }, { status: 400 });
  }
  try {
    return NextResponse.json(await priceParkside(asked as Horizon));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
