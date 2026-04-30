// Time-of-day bucket helpers. NEM market time is fixed AEST (Australia/Brisbane, no DST).
export const TOD_BUCKETS_PER_DAY = 288; // 24 * 60 / 5

export function bucketToLabel(bucket: number): string {
  const minutes = bucket * 5;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
}

export function bucketToHour(bucket: number): number {
  return Math.floor((bucket * 5) / 60);
}

export function bucketToHHMM(bucket: number): string {
  const minutes = bucket * 5;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
