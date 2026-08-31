import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { flushAll, flushProperty } from "@/lib/outbox";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const propertyId = new URL(request.url).searchParams.get("property");
  try {
    const reports = propertyId ? [await flushProperty(propertyId)] : await flushAll();
    return NextResponse.json({
      ran_at: new Date().toISOString(),
      properties: reports.length,
      sent: reports.reduce((n, r) => n + r.sent, 0),
      reports,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
