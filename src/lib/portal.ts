import { createClient } from "@supabase/supabase-js";

/**
 * Tells the Victory Suites guest portal that a guest has had their link, using
 * the portal's own fields, so the "Link sent" badge in its admin is true without
 * anyone pressing it. Set only when empty: the first send is the one that counts,
 * and a link the guest has already opened is shown as opened by the portal.
 */
export async function markPortalLinkSent(externalRef: string): Promise<void> {
  const url = process.env.PORTAL_SUPABASE_URL;
  const key = process.env.PORTAL_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const portal = createClient(url, key, { auth: { persistSession: false } });
  await portal
    .from("bookings")
    .update({
      portal_link_sent_at: new Date().toISOString(),
      portal_link_sent_by: "YourFrontDesk",
      portal_link_sent_via: "booking.com",
    })
    .eq("external_ref", externalRef)
    .is("portal_link_sent_at", null);
}
