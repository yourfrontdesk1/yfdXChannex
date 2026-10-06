import { NextResponse } from "next/server";
import { guard } from "@/lib/session";
import { addListing, goLive, type ListingInput } from "@/lib/listings";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Puts a Booking.com listing on sale through Channex in one call. See
 * src/lib/listings.ts for every step and why it is there.
 *
 * POST { name, hotel_id, room_types: [{ name, apartments, guests, floor, base, ceiling, bdc_room_code? }], activate }
 * POST { go_live: "<hub property id>" } switches on a listing set up earlier.
 */
export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  try {
    const body = (await request.json()) as ListingInput & { go_live?: string };
    if (body.go_live) return NextResponse.json(await goLive(body.go_live));
    return NextResponse.json(await addListing(body));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
