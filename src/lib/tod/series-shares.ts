import type { TodSeriesKey } from './timeline-client';

const SERIES_LABEL: Record<TodSeriesKey, string> = {
  mid_merit_gas: 'mid-merit',
  peaking_gas: 'peaking',
  battery_discharging: 'battery',
  hydro: 'hydro',
};

const SERIES_ORDER: TodSeriesKey[] = [
  'mid_merit_gas',
  'peaking_gas',
  'battery_discharging',
  'hydro',
];

export function formatSeriesShares(
  series: { fueltech: TodSeriesKey; buckets: number[] }[],
  bucket?: number,
): string {
  const totals = new Map<TodSeriesKey, number>();
  let grand = 0;
  for (const s of series) {
    let sum = 0;
    if (bucket != null) {
      sum = s.buckets[bucket] ?? 0;
    } else {
      for (const v of s.buckets) sum += v;
    }
    totals.set(s.fueltech, sum);
    grand += sum;
  }
  if (grand === 0) return '';
  return SERIES_ORDER.filter((k) => totals.has(k))
    .map((k) => `${SERIES_LABEL[k]} ${Math.round((totals.get(k)! / grand) * 100)}%`)
    .join(', ');
}

export function bucketToLowerLabel(b: number): string {
  const minutes = b * 5;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h < 12 ? 'am' : 'pm';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m.toString().padStart(2, '0')}${period}`;
}
