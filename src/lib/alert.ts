import { db } from "./db";

/**
 * One place that posts to YourFrontDesk's system-alert, which emails whoever
 * SYSTEM_ALERT_TO names (falling back to leon@victorygate.gi) and dedupes by
 * key, raising the same key at most once every 6 hours. Reused by the hourly
 * listing audit and the failed-forward watch.
 *
 * It reuses the booking.filed plumbing: the endpoint is the property's
 * downstream_url with "channex-webhook" swapped for "system-alert", and the
 * same downstream secret authenticates. Best effort: a failure here is never
 * allowed to break the caller, because an alert that cannot send must not also
 * sink the thing it was warning about.
 */
export async function systemAlert(
  problems: { key: string; title: string; lines: string[] }[],
): Promise<void> {
  if (!problems.length) return;
  const { data: p } = await db()
    .from("properties")
    .select("downstream_url, downstream_secret")
    .not("downstream_url", "is", null)
    .limit(1)
    .maybeSingle();
  if (!p?.downstream_url || !p.downstream_secret) return;
  await fetch((p.downstream_url as string).replace(/channex-webhook\/?$/, "system-alert"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-channex-webhook-secret": p.downstream_secret as string },
    body: JSON.stringify({ problems }),
  }).catch(() => null);
}
