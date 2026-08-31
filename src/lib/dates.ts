/** Dates are handled as plain YYYY-MM-DD strings. No timezone ever enters the grid. */

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  return toISODate(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

export function dateRange(start: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(addDays(start, i));
  return out;
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function weekday(iso: string): string {
  return WEEKDAYS[new Date(iso + "T00:00:00Z").getUTCDay()];
}

export function dayNumber(iso: string): string {
  return String(new Date(iso + "T00:00:00Z").getUTCDate());
}

export function monthLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
}

export function isWeekend(iso: string): boolean {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Collapse consecutive dates carrying an identical value into date_from and
 * date_to spans. This is what turns a week of edits into one value object, and
 * it is the difference between passing and failing the batching tests.
 */
export function collapseToSpans<T>(
  dates: string[],
  valueOf: (date: string) => T,
  same: (a: T, b: T) => boolean = (a, b) => a === b,
): { date_from: string; date_to: string; value: T }[] {
  const sorted = [...dates].sort();
  const spans: { date_from: string; date_to: string; value: T }[] = [];
  for (const date of sorted) {
    const value = valueOf(date);
    const last = spans[spans.length - 1];
    if (last && same(last.value, value) && addDays(last.date_to, 1) === date) {
      last.date_to = date;
    } else {
      spans.push({ date_from: date, date_to: date, value });
    }
  }
  return spans;
}
