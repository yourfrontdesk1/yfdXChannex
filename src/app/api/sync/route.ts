import { NextResponse } from "next/server";
import { guard } from "@/lib/session";
import { syncNow } from "@/lib/syncNow";
import { runJob } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** POST ?property=<hub id>. The Sync button. See src/lib/syncNow.ts. */
export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });
  const propertyId = new URL(request.url).searchParams.get("property");
  if (!propertyId) return NextResponse.json({ error: "property is required" }, { status: 400 });
  try {
    return NextResponse.json(await runJob("sync-now", () => syncNow(propertyId)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
