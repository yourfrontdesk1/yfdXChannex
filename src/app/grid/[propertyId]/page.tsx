import { redirect } from "next/navigation";
import { signedIn, authRequired } from "@/lib/session";
import Link from "next/link";
import { db } from "@/lib/db";
import RateGrid from "@/components/RateGrid";
import { dateRange, today } from "@/lib/dates";
import type { AriRow, Property, RatePlan, RoomType } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 30;

export default async function GridPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<{ start?: string; days?: string }>;
}) {
  if (authRequired() && !(await signedIn())) redirect("/sign-in");

  const { propertyId } = await params;
  const sp = await searchParams;

  const start = sp.start && /^\d{4}-\d{2}-\d{2}$/.test(sp.start) ? sp.start : today();
  const days = Math.min(Math.max(Number(sp.days) || DEFAULT_DAYS, 7), 120);
  const dates = dateRange(start, days);
  const end = dates[dates.length - 1];

  const supabase = db();

  const { data: property, error: propError } = await supabase
    .from("properties")
    .select("*")
    .eq("id", propertyId)
    .single();

  if (propError || !property) {
    return (
      <div className="card">
        <h2>Property not found</h2>
        <p className="legend">{propError?.message ?? propertyId}</p>
        <p>
          <Link href="/">Back to properties</Link>
        </p>
      </div>
    );
  }

  const { data: roomTypes } = await supabase
    .from("room_types")
    .select("*")
    .eq("property_id", propertyId)
    .order("sort")
    .order("name");

  const roomTypeIds = (roomTypes ?? []).map((r) => r.id);

  const { data: ratePlans } = roomTypeIds.length
    ? await supabase.from("rate_plans").select("*").in("room_type_id", roomTypeIds).order("name")
    : { data: [] as RatePlan[] };

  const { data: ari } = await supabase
    .from("ari")
    .select("*")
    .eq("property_id", propertyId)
    .gte("date", start)
    .lte("date", end);

  const { count: pending } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .is("sent_at", null);

  return (
    <RateGrid
      property={property as Property}
      roomTypes={(roomTypes ?? []) as RoomType[]}
      ratePlans={(ratePlans ?? []) as RatePlan[]}
      ari={(ari ?? []) as AriRow[]}
      dates={dates}
      start={start}
      days={days}
      pendingOutbox={pending ?? 0}
    />
  );
}
