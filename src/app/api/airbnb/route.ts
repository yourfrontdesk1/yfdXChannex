import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { connectAirbnb } from "@/lib/airbnb";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Connect the main Victory Suites property to Airbnb through Channex.
 *
 *   POST /api/airbnb?property=<id>&step=begin   records the connection and
 *                                               returns the OAuth link for Leon.
 *   POST /api/airbnb?property=<id>&step=map     after Leon authorises, reads the
 *                                               Airbnb listings and maps them,
 *                                               channel created switched off.
 *
 * step defaults to "begin". Nothing here activates the channel; going live is a
 * separate, deliberate step.
 */
export async function POST(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const url = new URL(request.url);
  const propertyId = url.searchParams.get("property");
  const step = url.searchParams.get("step") === "map" ? "map" : "begin";
  if (!propertyId) return NextResponse.json({ error: "property is required" }, { status: 400 });

  try {
    return NextResponse.json(await connectAirbnb(propertyId, { step }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
