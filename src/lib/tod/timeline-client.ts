// Client-side timeline loader. Reads pre-generated static binaries (one per region)
// and caches them in memory so any region/window/view change is a pure-JS operation.

export type TodSeriesKey = 'mid_merit_gas' | 'peaking_gas' | 'battery_discharging' | 'hydro';

export type Manifest = {
  generatedAt: string;
  startDate: string; // ISO 'YYYY-MM-DD' of frame 0
  endDate: string; // ISO 'YYYY-MM-DD' of last frame
  numDays: number;
  numBuckets: number;
  seriesNames: TodSeriesKey[];
  dtype: 'int16';
  unit: 'MW';
  files: Record<string, string>; // region → filename (under /data/)
};

export type TimelineSeries = {
  fueltech: TodSeriesKey;
  /** Length numDays × numBuckets, integer MW. Index: dayIdx × numBuckets + bucket. */
  values: Int16Array;
};

export type Timeline = {
  region: string;
  startDate: string;
  numDays: number;
  numBuckets: number;
  seriesNames: TodSeriesKey[];
  series: TimelineSeries[];
};

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const MANIFEST_URL = `${BASE_PATH}/data/manifest.json`;

let manifestPromise: Promise<Manifest> | null = null;
const regionPromises = new Map<string, Promise<Timeline>>();

export function loadManifest(): Promise<Manifest> {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`manifest fetch ${r.status}`);
        return r.json() as Promise<Manifest>;
      })
      .catch((e) => {
        manifestPromise = null; // allow retry
        throw e;
      });
  }
  return manifestPromise;
}

export function loadRegionTimeline(region: string): Promise<Timeline> {
  const cached = regionPromises.get(region);
  if (cached) return cached;
  const p = loadManifest().then(async (manifest) => {
    const filename = manifest.files[region];
    if (!filename) throw new Error(`no static file for region ${region}`);
    const r = await fetch(`${BASE_PATH}/data/${filename}`, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`region fetch ${r.status}`);
    const arr = new Int16Array(await r.arrayBuffer());
    const seriesLen = manifest.numDays * manifest.numBuckets;
    const series: TimelineSeries[] = manifest.seriesNames.map((ft, s) => ({
      fueltech: ft,
      values: arr.slice(s * seriesLen, (s + 1) * seriesLen),
    }));
    return {
      region,
      startDate: manifest.startDate,
      numDays: manifest.numDays,
      numBuckets: manifest.numBuckets,
      seriesNames: manifest.seriesNames,
      series,
    };
  });
  // Don't cache failures — let the caller retry.
  p.catch(() => regionPromises.delete(region));
  regionPromises.set(region, p);
  return p;
}

/**
 * Compute the rolling-windowDays average for each TOD bucket, ending at frame `frameIdx`.
 * For early frames where fewer than windowDays of data are available, averages over what's there.
 */
export function computeRollingFrame(
  timeline: Timeline,
  frameIdx: number,
  windowDays: number,
): { fueltech: TodSeriesKey; buckets: number[] }[] {
  const { numBuckets } = timeline;
  const start = Math.max(0, frameIdx - (windowDays - 1));
  const end = Math.min(timeline.numDays - 1, frameIdx);
  const n = Math.max(1, end - start + 1);
  return timeline.series.map((s) => {
    const buckets = new Array<number>(numBuckets).fill(0);
    for (let d = start; d <= end; d++) {
      const off = d * numBuckets;
      for (let b = 0; b < numBuckets; b++) buckets[b] += s.values[off + b];
    }
    for (let b = 0; b < numBuckets; b++) buckets[b] /= n;
    return { fueltech: s.fueltech, buckets };
  });
}

/** Bucket-by-bucket mean of `computeRollingFrame` across multiple frame positions. */
export function computeAveragedRollingFrame(
  timeline: Timeline,
  cmpFrames: number[],
  windowDays: number,
): { fueltech: TodSeriesKey; buckets: number[] }[] {
  if (cmpFrames.length === 0) return [];
  const perFrame = cmpFrames.map((f) => computeRollingFrame(timeline, f, windowDays));
  const numBuckets = perFrame[0][0].buckets.length;
  const out = perFrame[0].map((s) => ({
    fueltech: s.fueltech,
    buckets: new Array<number>(numBuckets).fill(0),
  }));
  const N = perFrame.length;
  for (const frame of perFrame) {
    for (let s = 0; s < frame.length; s++) {
      const target = out[s].buckets;
      const src = frame[s].buckets;
      for (let b = 0; b < numBuckets; b++) target[b] += src[b];
    }
  }
  for (let s = 0; s < out.length; s++) {
    const target = out[s].buckets;
    for (let b = 0; b < numBuckets; b++) target[b] /= N;
  }
  return out;
}

/** Inclusive frame index for the given ISO date relative to timeline.startDate. */
export function frameForDate(timeline: Pick<Timeline, 'startDate'>, iso: string): number {
  const start = new Date(`${timeline.startDate}T00:00:00Z`);
  const target = new Date(`${iso}T00:00:00Z`);
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

/** ISO date string for the given frame index. */
export function frameDate(
  timeline: Pick<Timeline, 'startDate' | 'numDays'>,
  frameIdx: number,
): string {
  const d = new Date(`${timeline.startDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + frameIdx);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
