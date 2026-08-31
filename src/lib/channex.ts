import { db } from "./db";

const BASES = {
  staging: "https://staging.channex.io/api/v1",
  production: "https://app.channex.io/api/v1",
} as const;

/**
 * Channex allow 20 ARI calls a minute per property, split as 10 to
 * /availability and 10 to /restrictions. The limiter counts calls out of
 * channex_log rather than memory, because a serverless process forgets what it
 * sent the moment it goes cold and the limit is per property, not per process.
 */
export const ARI_CALLS_PER_MINUTE = 10;

const RETRY_DELAYS_MS = [2000, 6000, 15000];

export type ChannexResult<T = unknown> = {
  ok: boolean;
  status: number;
  body: T | null;
  taskIds: string[];
  warnings: unknown[];
  error: string | null;
};

export function channexBase(): string {
  const env = (process.env.CHANNEX_ENV ?? "staging").toLowerCase();
  return env === "production" || env === "prod" ? BASES.production : BASES.staging;
}

export function channexEnv(): "staging" | "production" {
  const env = (process.env.CHANNEX_ENV ?? "staging").toLowerCase();
  return env === "production" || env === "prod" ? "production" : "staging";
}

function apiKey(): string {
  const key = process.env.CHANNEX_API_KEY;
  if (!key) throw new Error("CHANNEX_API_KEY is not set");
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Channex reject any field sent as null with "Should be a non null value or not
 * existed field", so an unset restriction has to be absent rather than empty.
 */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export async function channexRequest<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  opts: { propertyId?: string | null; retries?: number } = {},
): Promise<ChannexResult<T>> {
  const url = channexBase() + path;
  const maxAttempts = (opts.retries ?? RETRY_DELAYS_MS.length) + 1;

  let last: ChannexResult<T> = {
    ok: false,
    status: 0,
    body: null,
    taskIds: [],
    warnings: [],
    error: "no attempt made",
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const started = Date.now();
    let status = 0;
    let parsed: unknown = null;
    let error: string | null = null;

    try {
      const res = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-api-key": apiKey(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
      status = res.status;
      const text = await res.text();
      parsed = text ? safeJson(text) : null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const duration = Date.now() - started;
    const record = readEnvelope(parsed);

    // A 200 carrying warnings and an empty data array is a rejection wearing a
    // success status. Anything writing ARI has to treat that as a failure.
    const rejectedAsSuccess =
      status === 200 &&
      isAriPath(path) &&
      record.taskIds.length === 0 &&
      record.warnings.length > 0;

    const ok = !error && status >= 200 && status < 300 && !rejectedAsSuccess;

    last = {
      ok,
      status,
      body: parsed as T,
      taskIds: record.taskIds,
      warnings: record.warnings,
      error:
        error ??
        (rejectedAsSuccess
          ? "Channex returned 200 with warnings and no task, the values were rejected"
          : ok
            ? null
            : describeError(status, parsed)),
    };

    await logCall({
      propertyId: opts.propertyId ?? null,
      method,
      path,
      request: body ?? null,
      status,
      response: parsed,
      taskId: record.taskIds[0] ?? null,
      durationMs: duration,
    });

    const transient = error !== null || status === 429 || status >= 500;
    if (ok || !transient || attempt === maxAttempts - 1) return last;

    await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
  }

  return last;
}

function isAriPath(path: string): boolean {
  return path.startsWith("/availability") || path.startsWith("/restrictions");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

function readEnvelope(parsed: unknown): { taskIds: string[]; warnings: unknown[] } {
  const taskIds: string[] = [];
  const warnings: unknown[] = [];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const data = obj.data;
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          if (rec.type === "task" && typeof rec.id === "string") taskIds.push(rec.id);
        }
      }
    }
    const meta = obj.meta;
    if (meta && typeof meta === "object") {
      const w = (meta as Record<string, unknown>).warnings;
      if (Array.isArray(w)) warnings.push(...w);
    }
  }
  return { taskIds, warnings };
}

function describeError(status: number, parsed: unknown): string {
  if (status === 429) return "Rate limited by Channex";
  if (parsed && typeof parsed === "object") {
    const errors = (parsed as Record<string, unknown>).errors;
    if (errors) return `${status} ${JSON.stringify(errors).slice(0, 500)}`;
  }
  return `${status}`;
}

async function logCall(entry: {
  propertyId: string | null;
  method: string;
  path: string;
  request: unknown;
  status: number;
  response: unknown;
  taskId: string | null;
  durationMs: number;
}) {
  try {
    await db().from("channex_log").insert({
      property_id: entry.propertyId,
      method: entry.method,
      path: entry.path,
      request: entry.request,
      status: entry.status,
      response: entry.response,
      task_id: entry.taskId,
      duration_ms: entry.durationMs,
    });
  } catch {
    // Logging must never take a push down with it.
  }
}

/**
 * How many calls to this endpoint are still allowed for this property inside the
 * current minute. Anything the budget cannot cover stays in the outbox and goes
 * out on the next tick.
 */
export async function remainingAriBudget(propertyId: string, path: "/availability" | "/restrictions"): Promise<number> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await db()
    .from("channex_log")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .eq("path", path)
    .gte("at", since);

  if (error) return ARI_CALLS_PER_MINUTE;
  return Math.max(0, ARI_CALLS_PER_MINUTE - (count ?? 0));
}
