import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { connectBookingCom, provisionProperty } from "@/lib/provision";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const url = new URL(request.url);
  const propertyId = url.searchParams.get("property");
  const action = url.searchParams.get("action") ?? "provision";
  if (!propertyId) return NextResponse.json({ error: "property is required" }, { status: 400 });

  try {
    if (action === "connect") {
      const hotelId = url.searchParams.get("hotel_id");
      if (!hotelId) return NextResponse.json({ error: "hotel_id is required to connect" }, { status: 400 });
      return NextResponse.json(await connectBookingCom(propertyId, hotelId));
    }
    return NextResponse.json({ steps: await provisionProperty(propertyId) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
