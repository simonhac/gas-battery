// Week-anchor helpers. A `weekAnchor` is an ISO week's Monday (UTC, YYYY-MM-DD),
// matching `date_trunc('week', ts AT TIME ZONE 'Australia/Brisbane')` server-side.

export const FIRST_WEEK_ANCHOR = '2018-12-03'; // first Monday whose 12mo-prior window holds late-2017 data

const DAY_MS = 86_400_000;

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

/** ISO Monday of the week containing `d` (UTC). */
export function mondayOf(d: Date): string {
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const offsetToMon = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d.getTime() + offsetToMon * DAY_MS);
  return ymd(new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate())));
}

export function addWeeks(s: string, n: number): string {
  const d = parseDate(s);
  return ymd(new Date(d.getTime() + n * 7 * DAY_MS));
}

export function weeksBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round((b.getTime() - a.getTime()) / (7 * DAY_MS));
}

/** Most recent ISO Monday on or before `now`. */
export function currentWeekAnchor(now: Date = new Date()): string {
  return mondayOf(now);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Apr 2026" — the date as a friendly label. */
export function formatWeekLabel(s: string): string {
  const d = parseDate(s);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
