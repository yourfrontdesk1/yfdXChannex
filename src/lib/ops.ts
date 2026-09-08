import { db } from "./db";

/**
 * The bits that stop unattended work becoming invisible work.
 *
 * `enabled` is a switch a person can throw in the database while something is
 * going wrong, without waiting for a deploy. `record` writes down that a job
 * ran and what it did, so "when did pricing last work" has an answer that is
 * not a guess.
 */

export async function enabled(key: string): Promise<boolean> {
  const { data } = await db().from("hub_config").select("value").eq("key", key).maybeSingle();
  // Absent means on. A missing row should never silently stop the business.
  return data?.value !== "false";
}

export async function record(job: string, started: number, ok: boolean, detail: unknown, error?: string): Promise<void> {
  await db().from("job_runs").insert({
    job,
    ok,
    detail: detail ?? null,
    error: error ?? null,
    duration_ms: Date.now() - started,
  });
}

/** Wraps a scheduled job so it is always recorded, success or failure. */
export async function runJob<T>(job: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const out = await work();
    await record(job, started, true, out);
    return out;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await record(job, started, false, null, message);
    throw e;
  }
}

export type JobHealth = { job: string; last_ok: string | null; last_run: string | null; last_error: string | null; stale: boolean };

/** How long each job may go quiet before silence itself is the problem. */
const EXPECTED_GAP_MINUTES: Record<string, number> = {
  worker: 20,
  "availability-sync": 90,
  "pricing-near": 150,
  "pricing-mid": 150,
  "pricing-far": 1560,
  "bookings-poll": 60,
  "send-links": 30,
  "answer-messages": 20,
};

export async function health(): Promise<{ healthy: boolean; jobs: JobHealth[] }> {
  const supabase = db();
  const jobs: JobHealth[] = [];

  for (const [job, gap] of Object.entries(EXPECTED_GAP_MINUTES)) {
    const { data: runs } = await supabase
      .from("job_runs")
      .select("ok, ran_at, error")
      .eq("job", job)
      .order("ran_at", { ascending: false })
      .limit(20);

    const lastRun = runs?.[0]?.ran_at as string | undefined;
    const lastOk = runs?.find((r) => r.ok)?.ran_at as string | undefined;
    const lastError = runs?.find((r) => !r.ok)?.error as string | undefined;
    const minutesSince = lastOk ? (Date.now() - Date.parse(lastOk)) / 60000 : Infinity;

    jobs.push({
      job,
      last_ok: lastOk ?? null,
      last_run: lastRun ?? null,
      last_error: runs?.[0]?.ok === false ? (lastError ?? null) : null,
      stale: minutesSince > gap,
    });
  }

  return { healthy: jobs.every((j) => !j.stale), jobs };
}
