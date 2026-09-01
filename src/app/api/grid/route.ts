// Grid data as JSON, for a client that is not this app's own page.
//
// The Channels page in YourFrontDesk reads through here so the rate grid can
// live in the PMS while the integration Channex certified stays in one place.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { guard } from "@/lib/session";
import { addDays, today } from "@/lib/dates";
import type { AriRow, Property, RatePlan, RoomType } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const url = new URL(request.url);
  const propertyId = url.searchParams.get("property");
  const from = url.searchParams.get("from") || today();
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 1), 120);
  const to = addDays(from, days - 1);

  const supabase = db();

  if (!propertyId) {
    const { data } = await supabase.from("properties").select("*").order("name");
    return NextResponse.json({ properties: (data ?? []) as Property[] });
  }

  const { data: propertyRow } = await supabase
    .from("properties")
    .select("*")
    .eq("id", propertyId)
    .maybeSingle();
  if (!propertyRow) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  const { data: roomTypeRows } = await supabase
    .from("room_types")
    .select("*")
    .eq("property_id", propertyId)
    .order("sort");
  const roomTypes = (roomTypeRows ?? []) as RoomType[];

  const { data: ratePlanRows } = roomTypes.length
    ? await supabase.from("rate_plans").select("*").in("room_type_id", roomTypes.map((r) => r.id))
    : { data: [] as RatePlan[] };

  // Paged, because PostgREST caps a select at 1000 rows and a wide window over
  // several rate plans goes past that without saying so.
  const ari: AriRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data } = await supabase
      .from("ari")
      .select("*")
      .eq("property_id", propertyId)
      .gte("date", from)
      .lte("date", to)
      .order("date")
      .range(offset, offset + 999);
    const rows = (data ?? []) as AriRow[];
    ari.push(...rows);
    if (rows.length < 1000) break;
  }

  const { count: pending } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .is("sent_at", null);

  return NextResponse.json({
    property: propertyRow as Property,
    room_types: roomTypes,
    rate_plans: (ratePlanRows ?? []) as RatePlan[],
    ari,
    from,
    to,
    days,
    pending_in_outbox: pending ?? 0,
  });
}
