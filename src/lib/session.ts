/**
 * Sign-in for the operator UI.
 *
 * The grid writes rates and availability straight through to a channel manager,
 * so on a public URL it cannot be left open. This is deliberately small: one
 * shared operator account, a signed cookie, no user table. The service is a
 * back-office tool for one operator, not a consumer product, and a user table
 * here would be a second source of truth about who a customer is.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "ch_session";
const MAX_AGE_SECONDS = 60 * 60 * 12;

function secret(): string | null {
  return process.env.APP_SECRET || process.env.WORKER_SECRET || null;
}

function sign(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

/** `<expiry>.<signature>`, so a stolen cookie stops working on its own. */
export function issueToken(): string | null {
  const key = secret();
  if (!key) return null;
  const expires = String(Date.now() + MAX_AGE_SECONDS * 1000);
  return `${expires}.${sign(expires, key)}`;
}

export function tokenValid(token: string | undefined | null): boolean {
  const key = secret();
  if (!key || !token) return false;
  const [expires, signature] = token.split(".");
  if (!expires || !signature) return false;
  if (Number(expires) < Date.now()) return false;

  const expected = sign(expires, key);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Whether the caller holds a valid session cookie. */
export async function signedIn(): Promise<boolean> {
  const jar = await cookies();
  return tokenValid(jar.get(SESSION_COOKIE)?.value);
}

/**
 * The password for the operator account. Absent in local development, where
 * requiring a password every time helps nobody; required in production, and
 * `authRequired` below is what refuses to serve without it.
 */
export function operatorPassword(): string | null {
  return process.env.APP_PASSWORD || null;
}

export function authRequired(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Route guard. Returns null when the request may proceed, or the reason it may
 * not. A session cookie is the normal path; the worker secret is also accepted
 * so the machine routes and any scheduled caller keep working unchanged.
 */
export async function guard(request: Request): Promise<string | null> {
  if (!authRequired()) return null;

  if (!operatorPassword()) return "APP_PASSWORD is not set on this deployment";

  const header =
    request.headers.get("x-worker-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;
  const workerSecret = process.env.WORKER_SECRET;
  if (header && workerSecret && header.length === workerSecret.length) {
    if (timingSafeEqual(Buffer.from(header), Buffer.from(workerSecret))) return null;
  }

  return (await signedIn()) ? null : "Not signed in";
}
