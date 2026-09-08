import { NextResponse } from "next/server";
import { health } from "@/lib/ops";

export const dynamic = "force-dynamic";

/**
 * Deliberately open. It says whether the scheduled work is running, nothing
 * about a guest or a price, so anything that can watch a URL can watch this.
 */
export async function GET() {
  try {
    const report = await health();
    return NextResponse.json(report, { status: report.healthy ? 200 : 503 });
  } catch (e) {
    return NextResponse.json({ healthy: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
