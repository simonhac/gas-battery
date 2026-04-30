// Month-anchor helpers. A `monthAnchor` is the first day of a UTC month, used as
// the exclusive upper bound of a rolling window (e.g. monthAnchor=2024-05-01 means
// window ends just before May 2024).

export const FIRST_MONTH_ANCHOR = '2018-12-01'; // first 12mo-window endpoint after late-2017

export function monthAnchorString(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export function parseMonthAnchor(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

export function addMonths(s: string, n: number): string {
  const d = parseMonthAnchor(s);
  d.setUTCMonth(d.getUTCMonth() + n);
  return monthAnchorString(d);
}

export function monthsBetween(from: string, to: string): number {
  const a = parseMonthAnchor(from);
  const b = parseMonthAnchor(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

export function currentMonthAnchor(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatMonthLabel(s: string): string {
  const d = parseMonthAnchor(s);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
