/**
 * The Airbnb listing map for the main Victory Suites property, as Little
 * Hotelier holds it today (Leon pasted the LH Airbnb mapping on 27 Oct 2026,
 * see vs-room-membership-lh-calendar.md). One Airbnb listing per hub room type.
 *
 * This is data, not a matching heuristic. Each entry ties a hub room type to the
 * one Airbnb listing that sells it, keyed two ways so the connect can find the
 * hub room type however it is labelled:
 *   - bdcRoomCode: the Booking.com room id already stored on the hub row as
 *     room_types.ota_room_type_code (the canonical, stable join once the main
 *     listing's Booking.com channel is mapped).
 *   - lhName: the Little Hotelier / hub room type name, as a fallback match.
 *
 * CRITICAL (owner, 28 Oct 2026): each Airbnb listing sells ALL the apartments of
 * its room type, exactly like Booking.com. It gets the room type's REAL
 * availability. There is NO max_availability = 1 cap. Do not add one.
 *
 * "1 bed" is DISABLED in LH's Airbnb mapping (its Airbnb listing is switched off),
 * so it is excluded from the connect: no mapping entry is built for it.
 *
 * The jacuzzi room ("11.01 with jacuzzi", BDC 1575589914) and the dead "Studio
 * Apartment" (192118) are not on Airbnb at all, so they have no entry here and
 * are simply skipped by the builder.
 */

export type AirbnbListingMapEntry = {
  /** Little Hotelier / hub room type name. */
  lhName: string;
  /** Booking.com room id, == room_types.ota_room_type_code on the hub row. */
  bdcRoomCode: string;
  /** The Airbnb listing title as Channex returns it after OAuth (matched loosely). */
  airbnbListingTitle: string;
  /** LH shows this listing as a disabled channel rate; excluded from the connect. */
  disabled?: boolean;
};

/** All Booking.com room ids on the main listing share this prefix (hotel 15755899). */
const BDC = (twoDigit: string) => `15755899${twoDigit}`;

export const AIRBNB_LISTING_MAP: AirbnbListingMapEntry[] = [
  { lhName: "studio other floors",            bdcRoomCode: BDC("01"), airbnbListingTitle: "studio In Victory suites" },
  { lhName: "Exec Studio 6th Floor",          bdcRoomCode: BDC("02"), airbnbListingTitle: "Exec Studio In Gibraltar" },
  { lhName: "1 bed 6th floor",                bdcRoomCode: BDC("03"), airbnbListingTitle: "1 bedroom Apartment in Gibraltar" },
  { lhName: "Studio 10th 11th floor",         bdcRoomCode: BDC("04"), airbnbListingTitle: "Studio 10th/11th floor" },
  { lhName: "2 bed 6th floor",                bdcRoomCode: BDC("05"), airbnbListingTitle: "2 bedroom Apartment In Gibraltar" },
  { lhName: "Exec Studio 10th 11th floor",    bdcRoomCode: BDC("06"), airbnbListingTitle: "Exec Studio 10th/11th Floor" },
  { lhName: "1 bed 10th 11th floor",          bdcRoomCode: BDC("07"), airbnbListingTitle: "1 bedroom 10th/11th floor" },
  { lhName: "2 bed on 10th 11th floor",       bdcRoomCode: BDC("08"), airbnbListingTitle: "2 Bedroom 10th/11th Floor" },
  { lhName: "Studios 6TH Floor",              bdcRoomCode: BDC("09"), airbnbListingTitle: "Studio in Gibraltar" },
  { lhName: "Exec Studio",                    bdcRoomCode: BDC("10"), airbnbListingTitle: "Exec Studio Victory Suites" },
  { lhName: "1 bed",                          bdcRoomCode: BDC("11"), airbnbListingTitle: "1 bedroom apartment Victory Suites", disabled: true },
  { lhName: "2 bedroom apartment",            bdcRoomCode: BDC("12"), airbnbListingTitle: "2 bedroom apartment Victory Suites" },
];

/** Case and whitespace insensitive, so "Studio 10th/11th Floor" matches the file. */
export function normaliseTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Find the map entry for a hub room type by its Booking.com code, else by name. */
export function findAirbnbEntry(roomType: { name: string; ota_room_type_code?: string | null }): AirbnbListingMapEntry | null {
  const byCode = roomType.ota_room_type_code
    ? AIRBNB_LISTING_MAP.find((e) => e.bdcRoomCode === roomType.ota_room_type_code)
    : null;
  if (byCode) return byCode;
  const name = normaliseTitle(roomType.name);
  return AIRBNB_LISTING_MAP.find((e) => normaliseTitle(e.lhName) === name) ?? null;
}
