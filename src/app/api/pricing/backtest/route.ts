import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { backtestParkside } from "@/lib/backtest";
import { runJob } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 180), 30), 400);
  try {
    return NextResponse.json(await runJob("backtest", () => backtestParkside(days)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
