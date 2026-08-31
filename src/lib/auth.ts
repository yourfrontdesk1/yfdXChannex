/**
 * The worker and sync routes are machine endpoints. A shared secret in a header
 * or a query string is enough, and the query form exists because some cron
 * runners cannot set headers.
 */
export function authorised(request: Request, secretName: "WORKER_SECRET" | "CHANNEX_WEBHOOK_SECRET"): boolean {
  const expected = process.env[secretName];
  if (!expected) return process.env.NODE_ENV !== "production";

  const header =
    request.headers.get("x-worker-secret") ??
    request.headers.get("x-channex-webhook-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;
  if (header && safeEqual(header, expected)) return true;

  const url = new URL(request.url);
  const query = url.searchParams.get("secret");
  return query !== null && safeEqual(query, expected);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
