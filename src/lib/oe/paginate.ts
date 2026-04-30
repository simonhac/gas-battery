// 5-minute resolution requires <= 8-day windows per OE API call.
// Window iterator: yields [start, end) chunks until we hit the target.
const WINDOW_MS = 8 * 86_400_000;

export type Window = { dateStart: Date; dateEnd: Date };

export function* iterateWindows(cursor: Date, target: Date): Generator<Window> {
  let s = cursor.getTime();
  const t = target.getTime();
  while (s < t) {
    const e = Math.min(s + WINDOW_MS, t);
    yield { dateStart: new Date(s), dateEnd: new Date(e) };
    s = e;
  }
}

/**
 * Format a Date as a timezone-naive wall-clock string for the OE API. The OE API
 * expects times in the network's local timezone with no offset suffix
 * (AEST/UTC+10 for NEM, AWST/UTC+8 for WEM — both fixed offsets, no DST).
 */
export function toNaiveLocal(d: Date, tzOffsetHours: number): string {
  return new Date(d.getTime() + tzOffsetHours * 3_600_000).toISOString().slice(0, 19);
}

/** The latest 5-minute boundary that's at least `safetyMin` minutes in the past. */
export function lastCompleteBoundary(now: Date, safetyMin = 15): Date {
  const safe = now.getTime() - safetyMin * 60_000;
  return new Date(Math.floor(safe / 300_000) * 300_000);
}
