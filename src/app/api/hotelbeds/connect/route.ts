import { NextResponse } from "next/server";
import { authorised } from "@/lib/auth";
import { connectHotelbeds, type HotelbedsRoomPair } from "@/lib/hotelbeds";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Connect the main Victory Suites property to Hotelbeds, switched off. Hotelbeds
 * is a receive-only bedbank, so this is the ARI-out + mapping side; bookings come
 * back as references and are already filed by bookings.ts (ota_name "HBD").
 *
 * The pairing (hub room type -> Hotelbeds room code + rate code) and the contract
 * type come from Leon / Channex mapping_details, so they are POSTed in rather than
 * read from stored codes. Nothing is activated here: connectHotelbeds always
 * creates the channel inactive and returns Channex readiness.
 *
 * Body: { propertyId, hotelId, pairing: HotelbedsRoomPair[], contractType?, extraSettings? }
 */
export async function POST(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: {
    propertyId?: string;
    hotelId?: string;
    pairing?: HotelbedsRoomPair[];
    contractType?: string;
    extraSettings?: Record<string, unknown>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "A JSON body is required" }, { status: 400 });
  }

  const propertyId = body.propertyId?.trim();
  const hotelId = body.hotelId?.trim();
  if (!propertyId) return NextResponse.json({ error: "propertyId is required" }, { status: 400 });
  if (!hotelId) return NextResponse.json({ error: "hotelId (the Hotelbeds hotel identifier) is required" }, { status: 400 });
  if (!Array.isArray(body.pairing) || body.pairing.length === 0) {
    return NextResponse.json({ error: "pairing is required (hub room type -> Hotelbeds room code + rate code)" }, { status: 400 });
  }

  try {
    const result = await connectHotelbeds(propertyId, hotelId, body.pairing, {
      contractType: body.contractType,
      extraSettings: body.extraSettings,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
