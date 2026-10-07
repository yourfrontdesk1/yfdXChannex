import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Resolved in YourFrontDesk means resolved here. A thread with an open hand
 * over is never answered automatically again, and pressing Resolved used to
 * clear only YourFrontDesk's copy, so that guest went to a person forever.
 * POST { external_ref }
 */
export async function POST(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { external_ref?: string };
  const code = String(body.external_ref ?? "").replace(/^[A-Z]{3}-/, "").trim();
  if (!code) return NextResponse.json({ error: "external_ref is required" }, { status: 400 });
  const supabase = db();
  const { data: rows } = await supabase.from("inbound_bookings").select("channex_booking_id").eq("ota_reservation_code", code);
  const ids = [...new Set((rows ?? []).map((r) => r.channex_booking_id).filter(Boolean))] as string[];
  if (!ids.length) return NextResponse.json({ ok: true, resolved: 0 });
  const { data } = await supabase
    .from("escalations")
    .update({ resolved_at: new Date().toISOString() })
    .in("channex_booking_id", ids)
    .is("resolved_at", null)
    .select("id");
  return NextResponse.json({ ok: true, resolved: data?.length ?? 0 });
}
