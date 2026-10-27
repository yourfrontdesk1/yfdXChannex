import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authorised } from "@/lib/auth";
import { db } from "@/lib/db";
import { runJob } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * A safety net for the ~600 pre switch (SiteMinder era) bookings.
 *
 * After cutover, a cancellation that reaches the hub but fails to propagate to
 * the guest portal leaves the portal holding the room blocked for ever: the
 * guest is gone, the night is dead, and nothing notices. The ordinary forward
 * path and its retry cron cover revisions received after cutover; this is the
 * belt and braces for cancels that were received but never forwarded, found by
 * comparing the hub's own latest state against the portal rather than against a
 * forward_error flag.
 *
 * LIMITATION, stated plainly so nobody mistakes this for complete coverage:
 * this only catches cancels the HUB RECEIVED. A cancellation that never reaches
 * Channex at all cannot be detected here. If Booking.com does not route a cancel
 * for an old (pre switch) booking to the new connectivity provider, the hub
 * never hears of it, so there is no 'cancelled' revision to find, and the portal
 * keeps the room blocked with nothing to reconcile against. Those require a
 * manual Booking.com reconciliation report (export cancellations from the
 * extranet and diff against the portal); they are out of scope for this route.
 *
 * Read mostly and idempotent: re sending a cancel for a booking the portal has
 * already deactivated is a no op on the portal side, so a re run is harmless.
 */

const OTA_PREFIX: Record<string, string> = {
  bookingcom: "BDC",
  "booking.com": "BDC",
  hotelbeds: "HBD",
  expedia: "EXP",
  airbnb: "ABB",
  agoda: "AGD",
};

type StoredRevision = {
  id?: string;
  revision_id?: string;
  booking_id?: string;
  unique_id?: string;
  ota_reservation_code?: string;
  ota_name?: string;
};

/**
 * The external reference the rest of the estate uses. Mirrors externalRefFor in
 * src/lib/bookings.ts (which is not exported); kept in step with it so the ref
 * we re send a cancel for matches the one the portal filed the booking under.
 */
function externalRefFor(revision: StoredRevision, fallbackId: string): string {
  const raw = revision.ota_reservation_code ?? revision.unique_id ?? revision.booking_id ?? fallbackId;
  const prefix = OTA_PREFIX[String(revision.ota_name ?? "").toLowerCase().replace(/\s+/g, "")];
  return prefix && !String(raw).includes("-") ? `${prefix}-${raw}` : String(raw);
}

type LatestRevision = { channexBookingId: string; externalRef: string };

/** The newest revision of every hub booking whose latest status is 'cancelled'. */
async function cancelledHubBookings(): Promise<LatestRevision[]> {
  const hub = db();
  // PostgREST caps a select at 1000 rows and the listing holds far more
  // revisions than that, so page it, newest first, and keep only the first
  // (newest) revision seen per booking.
  const latest = new Map<string, { status: string | null; revision: StoredRevision; revisionId: string }>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error } = await hub
      .from("inbound_bookings")
      .select("channex_booking_id, revision_id, status, ota_reservation_code, payload")
      .order("received_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Reading inbound_bookings: ${error.message}`);
    for (const r of page ?? []) {
      const key = (r.channex_booking_id as string | null) ?? (r.revision_id as string);
      if (latest.has(key)) continue; // newest wins; later pages are older
      latest.set(key, {
        status: r.status as string | null,
        revision: (r.payload as StoredRevision | null) ?? { ota_reservation_code: r.ota_reservation_code as string | undefined },
        revisionId: r.revision_id as string,
      });
    }
    if (!page || page.length < PAGE) break;
  }

  const out: LatestRevision[] = [];
  for (const [channexBookingId, v] of latest) {
    if (String(v.status ?? "").toLowerCase() !== "cancelled") continue;
    out.push({ channexBookingId, externalRef: externalRefFor(v.revision, v.revisionId) });
  }
  return out;
}

/**
 * Of the given external refs, which the portal STILL shows active. Read only.
 * A ref is active if any booking row for it is active, not cancelled by status,
 * and not cancelled on the channel (ota_status) — the same test portalMirror
 * uses, because a Booking.com cancel the portal never heard still counts.
 */
async function stillActiveOnPortal(refs: string[]): Promise<Set<string>> {
  const url = process.env.PORTAL_SUPABASE_URL, key = process.env.PORTAL_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("PORTAL_SUPABASE_URL and PORTAL_SERVICE_ROLE_KEY are not set");
  const portal = createClient(url, key, { auth: { persistSession: false } });

  const active = new Set<string>();
  const CHUNK = 200;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const slice = refs.slice(i, i + CHUNK);
    const { data, error } = await portal
      .from("bookings")
      .select("external_ref, is_active, status, ota_status")
      .in("external_ref", slice);
    if (error) throw new Error(`Portal bookings: ${error.message}`);
    for (const b of data ?? []) {
      const isLive =
        b.is_active &&
        String(b.status ?? "").toLowerCase() !== "cancelled" &&
        String(b.ota_status ?? "").toLowerCase() !== "cancelled";
      if (isLive) active.add(b.external_ref as string);
    }
  }
  return active;
}

async function reconcile(): Promise<{ cancelled_in_hub: number; stale_on_portal: number; reconciled: number; errors: string[] }> {
  const out = { cancelled_in_hub: 0, stale_on_portal: 0, reconciled: 0, errors: [] as string[] };

  const cancelled = await cancelledHubBookings();
  out.cancelled_in_hub = cancelled.length;
  if (cancelled.length === 0) return out;

  // Dedupe refs: two feeds can point one booking at one external_ref.
  const refToBooking = new Map<string, string>();
  for (const c of cancelled) if (!refToBooking.has(c.externalRef)) refToBooking.set(c.externalRef, c.channexBookingId);

  const active = await stillActiveOnPortal([...refToBooking.keys()]);
  out.stale_on_portal = active.size;
  if (active.size === 0) return out;

  const portalBase = process.env.PORTAL_API_URL?.replace(/\/$/, "");
  const portalKey = process.env.PORTAL_API_KEY;
  if (!portalBase || !portalKey) throw new Error("PORTAL_API_URL or PORTAL_API_KEY is not set");
  const portalUrl = `${portalBase}/api/external/bookings`;
  const previewBypass = process.env.PORTAL_PREVIEW_BYPASS;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${portalKey}`,
    ...(previewBypass ? { "x-vercel-protection-bypass": previewBypass } : {}),
  };

  for (const externalRef of active) {
    try {
      // Reuse the portal cancel call shape. Re sending a cancel for a booking
      // the portal has already deactivated is a no op, so this is idempotent.
      const res = await fetch(portalUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "cancelled", external_ref: externalRef }),
      });
      if (res.ok) {
        out.reconciled++;
      } else {
        const text = await res.text().catch(() => "");
        out.errors.push(`${externalRef}: ${res.status} ${text.slice(0, 160)}`);
      }
    } catch (e) {
      out.errors.push(`${externalRef}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return out;
}

async function run(request: Request) {
  if (!authorised(request, "WORKER_SECRET")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ran_at: new Date().toISOString(), ...(await runJob("reconcile-cancels", reconcile)) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = run;
