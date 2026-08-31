import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { fullSync } from "@/lib/fullsync";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const url = new URL(request.url);
  const propertyId = url.searchParams.get("property");
  if (!propertyId) return NextResponse.json({ error: "property is required" }, { status: 400 });

  const force = url.searchParams.get("force") === "1";
  try {
    return NextResponse.json(await fullSync(propertyId, { force }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
