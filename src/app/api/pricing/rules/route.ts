import { NextResponse } from "next/server";
import { guard } from "@/lib/session";
import { db } from "@/lib/db";
import { priceProperty } from "@/lib/pricing";
import { runJob } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The price fence per room type: floor, base and ceiling, in what Victory Suites
 * keeps per night. The engine moves inside it; commission and tourist tax go on
 * top of whatever it decides. Readable and editable from YourFrontDesk through
 * the channels proxy, so a host changes prices where they work.
 *
 * GET  ?property=<hub id>      the fence for each room type of that property
 * POST { room_type_id, floor, base, ceiling }   changes one, then reprices that
 *      property straight away so the new fence reaches Booking.com within a minute
 */
export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });
  const propertyId = new URL(request.url).searchParams.get("property");
  if (!propertyId) return NextResponse.json({ error: "property is required" }, { status: 400 });

  const hub = db();
  const { data: rts } = await hub.from("room_types").select("id, name").eq("property_id", propertyId);
  const { data: rules } = await hub
    .from("pricing_rules")
    .select("room_type_id, floor_rate, base_rate, ceiling_rate, updated_at")
    .in("room_type_id", (rts ?? []).map((r) => r.id));
  const { data: cfg } = await hub.from("hub_config").select("key, value").in("key", ["channel_commission_pct", "tourist_tax_per_person"]);
  return NextResponse.json({
    rules: (rules ?? []).map((r) => ({
      room_type_id: r.room_type_id,
      name: (rts ?? []).find((t) => t.id === r.room_type_id)?.name ?? null,
      floor: Number(r.floor_rate),
      base: Number(r.base_rate),
      ceiling: Number(r.ceiling_rate),
      updated_at: r.updated_at,
    })),
    commission_pct: Number((cfg ?? []).find((c) => c.key === "channel_commission_pct")?.value ?? 0),
    tourist_tax_per_person: Number((cfg ?? []).find((c) => c.key === "tourist_tax_per_person")?.value ?? 0),
  });
}

export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { room_type_id?: string; floor?: number; base?: number; ceiling?: number };
  const floor = Number(body.floor), base = Number(body.base), ceiling = Number(body.ceiling);
  if (!body.room_type_id) return NextResponse.json({ error: "room_type_id is required" }, { status: 400 });
  if (!(floor > 0 && floor <= base && base <= ceiling)) {
    return NextResponse.json({ error: "Prices must run floor, then base, then ceiling, all above zero" }, { status: 400 });
  }

  const hub = db();
  const { data: rt } = await hub.from("room_types").select("property_id").eq("id", body.room_type_id).maybeSingle();
  if (!rt) return NextResponse.json({ error: "No such room type" }, { status: 404 });

  const { error } = await hub
    .from("pricing_rules")
    .update({ floor_rate: floor, base_rate: base, ceiling_rate: ceiling, updated_at: new Date().toISOString() })
    .eq("room_type_id", body.room_type_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Applied now rather than at the next half hour, so the change is visible.
  // The engine still walks prices a few percent per run, which is what stops a
  // listing lurching; a fence moved below today's price pulls it down at once.
  const repriced = await runJob(`pricing-manual`, () => priceProperty(rt.property_id as string, "all"));
  return NextResponse.json({ ok: true, repriced });
}
