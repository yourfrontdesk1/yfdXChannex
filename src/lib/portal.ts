import { createClient } from "@supabase/supabase-js";

/**
 * Records on the Victory Suites guest portal that a guest has been sent their
 * portal link, using the portal's own fields, so its "Link sent" count is true
 * without anyone pressing anything.
 *
 * The portal shows the total as 1 + portal_link_reminders:
 *  - the first send stamps portal_link_sent_at, _by and _via, and is never
 *    overwritten afterwards;
 *  - every later send (a reminder, a manual resend) adds 1 to
 *    portal_link_reminders.
 * Leon asked on 2 Nov 2026 for every send to be counted, not only the first.
 */

/** How the portal names the channel a link went out on. */
export function channelLabel(otaName: string | null | undefined): string {
  const ota = String(otaName ?? "").toLowerCase().replace(/\s+/g, "");
  if (ota.includes("booking")) return "booking.com";
  if (ota.includes("expedia")) return "expedia";
  if (ota.includes("airbnb")) return "airbnb";
  if (ota.includes("hotelbeds")) return "hotelbeds";
  if (ota.includes("agoda")) return "agoda";
  return ota || "channex";
}

const PREFIX: Record<string, string> = {
  "booking.com": "BDC",
  expedia: "EXP",
  airbnb: "ABB",
  agoda: "AGD",
};

/**
 * The reference the portal keys a booking by, from what Channex sent: the same
 * convention bookings.ts uses when it forwards the booking (BDC-6639721282,
 * EXP-2594032727, HBD-1114132-102-21517073).
 */
export function portalRefFor(otaName: string | null | undefined, code: string): string {
  const raw = code.trim();
  if (/^[A-Z]{3}-/.test(raw)) return raw;
  const channel = channelLabel(otaName);
  if (channel === "hotelbeds") return `HBD-1114132-${raw}`;
  const prefix = PREFIX[channel] ?? "BDC";
  return raw.includes("-") ? raw : `${prefix}-${raw}`;
}

/** True when a message carries the guest's portal link, so it counts as a send. */
export function carriesPortalLink(text: string): boolean {
  return /guestportal\.victorysuites\.gi\/guest\//i.test(text);
}

export type PortalSendRecord = { first: number; repeat: number };

export async function recordPortalLinkSend(
  externalRef: string,
  via: string,
  by = "YourFrontDesk",
): Promise<PortalSendRecord> {
  const result: PortalSendRecord = { first: 0, repeat: 0 };
  const url = process.env.PORTAL_SUPABASE_URL;
  const key = process.env.PORTAL_SERVICE_ROLE_KEY;
  if (!url || !key || !externalRef) return result;
  const portal = createClient(url, key, { auth: { persistSession: false } });

  // A group booking is several portal rows under one reference; each one is
  // the same guest's link, so each is recorded.
  const { data: rows } = await portal
    .from("bookings")
    .select("id, portal_link_sent_at, portal_link_reminders")
    .eq("external_ref", externalRef);

  for (const row of rows ?? []) {
    if (!row.portal_link_sent_at) {
      // Guarded on still being empty, so two sends at once cannot both claim
      // to be the first; the loser is counted as a repeat below.
      const { data: claimed } = await portal
        .from("bookings")
        .update({ portal_link_sent_at: new Date().toISOString(), portal_link_sent_by: by, portal_link_sent_via: via })
        .eq("id", row.id as string)
        .is("portal_link_sent_at", null)
        .select("id");
      if (claimed && claimed.length) { result.first++; continue; }
    }
    const { data: fresh } = await portal
      .from("bookings")
      .select("portal_link_reminders")
      .eq("id", row.id as string)
      .maybeSingle();
    await portal
      .from("bookings")
      .update({ portal_link_reminders: Number(fresh?.portal_link_reminders ?? row.portal_link_reminders ?? 0) + 1 })
      .eq("id", row.id as string);
    result.repeat++;
  }
  return result;
}
