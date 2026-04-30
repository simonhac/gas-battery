import { bucketToHHMM } from '@/lib/time/tod';
import {
  computeAveragedRollingFrame,
  computeRollingFrame,
  frameDate,
  type Timeline,
  type TodSeriesKey,
} from './timeline-client';

const SERIES_ORDER: TodSeriesKey[] = [
  'mid_merit_gas',
  'peaking_gas',
  'battery_discharging',
  'hydro',
];

function activeSeries(
  timeline: Timeline,
  visibleSeries: Set<TodSeriesKey>,
): TodSeriesKey[] {
  return SERIES_ORDER.filter(
    (k) => timeline.seriesNames.includes(k) && visibleSeries.has(k),
  );
}

function fmt(n: number): string {
  return n.toFixed(2);
}

export type YearTileData = {
  year: number;
  windowEnd: string;
  series: { fueltech: TodSeriesKey; buckets: number[] }[];
};

export function buildYearsCsv(
  timeline: Timeline,
  tiles: YearTileData[],
  visibleSeries: Set<TodSeriesKey>,
): string {
  const cols = activeSeries(timeline, visibleSeries);
  const header = ['year', 'window_end', 'bucket', 'time_of_day', ...cols.map((c) => `${c}_mw`)];
  const out: string[] = [header.join(',')];
  for (const tile of tiles) {
    const byFt = new Map(tile.series.map((s) => [s.fueltech, s.buckets]));
    for (let b = 0; b < timeline.numBuckets; b++) {
      const row: string[] = [
        String(tile.year),
        tile.windowEnd,
        String(b),
        bucketToHHMM(b),
      ];
      for (const c of cols) row.push(fmt(byFt.get(c)?.[b] ?? 0));
      out.push(row.join(','));
    }
  }
  return out.join('\n') + '\n';
}

export type CmpExportConfig = {
  /** For a given user frame f, the cmp frame indices to average across (1 for yearsAgo, N for avg). */
  cmpFramesFor: (f: number) => number[];
  /** Label written to the `cmp_label` column for that user frame. */
  labelFor: (f: number) => string;
};

export function buildRollingCsv(
  timeline: Timeline,
  firstFrame: number,
  lastFrame: number,
  windowDays: number,
  visibleSeries: Set<TodSeriesKey>,
  cmp?: CmpExportConfig,
): string {
  const cols = activeSeries(timeline, visibleSeries);
  const cmpHeader = cmp ? ['cmp_label', ...cols.map((c) => `${c}_cmp_mw`)] : [];
  const header = ['date', 'bucket', 'time_of_day', ...cols.map((c) => `${c}_mw`), ...cmpHeader];
  const out: string[] = [header.join(',')];
  for (let f = firstFrame; f <= lastFrame; f++) {
    const date = frameDate(timeline, f);
    const frame = computeRollingFrame(timeline, f, windowDays);
    const byFt = new Map(frame.map((s) => [s.fueltech, s.buckets]));

    let cmpByFt: Map<TodSeriesKey, number[]> | null = null;
    let cmpLabel = '';
    if (cmp) {
      const cmpFrames = cmp.cmpFramesFor(f);
      const avg = computeAveragedRollingFrame(timeline, cmpFrames, windowDays);
      cmpByFt = new Map(avg.map((s) => [s.fueltech, s.buckets]));
      cmpLabel = cmp.labelFor(f);
    }

    for (let b = 0; b < timeline.numBuckets; b++) {
      const row: string[] = [date, String(b), bucketToHHMM(b)];
      for (const c of cols) row.push(fmt(byFt.get(c)?.[b] ?? 0));
      if (cmp && cmpByFt) {
        row.push(cmpLabel);
        for (const c of cols) row.push(fmt(cmpByFt.get(c)?.[b] ?? 0));
      }
      out.push(row.join(','));
    }
  }
  return out.join('\n') + '\n';
}

export function downloadCsv(filename: string, csvText: string): void {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
