'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { TodChart } from './TodChart';
import { TodTimelineSummary } from './TodTimelineSummary';
import { DateInput } from './DateInput';
import { ExportCsvButton } from './ExportCsvButton';
import { DataAttribution } from './DataAttribution';
import { buildRollingCsv, type CmpExportConfig } from '@/lib/tod/csv-export';
import {
  computeAveragedRollingFrame,
  computeRollingFrame,
  frameDate,
  frameForDate,
  loadRegionTimeline,
  type Timeline,
  type TodSeriesKey,
} from '@/lib/tod/timeline-client';
import type { Region } from '@/lib/regions';

const NUM_BUCKETS = 288;

type TimelineAggregates = {
  /** Per-frame mean MW, indexed [0..numDays). null when the series is disabled. */
  midMeritTotal: Float32Array | null;
  peakersTotal: Float32Array | null;
  batTotal: Float32Array | null;
  hydroTotal: Float32Array | null;
  /** Max stacked-MW any TOD bucket reaches across [firstFrame..lastFrame]. */
  maxStackedBucket: number;
};

function seriesValues(timeline: Timeline, key: TodSeriesKey): Int16Array | null {
  const idx = timeline.seriesNames.indexOf(key);
  return idx >= 0 ? timeline.series[idx].values : null;
}

/**
 * Rolling-windowDays mean across [firstFrame..lastFrame], using a running-sum optimisation.
 * Outputs per-frame arrays sized to timeline.numDays; values outside [firstFrame..lastFrame] are 0.
 * Each series is computed only when its key is in `visibleSeries` (and present in the timeline).
 */
function computeAggregates(
  timeline: Timeline,
  windowDays: number,
  firstFrame: number,
  lastFrame: number,
  visibleSeries: Set<TodSeriesKey>,
): TimelineAggregates {
  const numFrames = timeline.numDays;
  const mid = visibleSeries.has('mid_merit_gas') ? seriesValues(timeline, 'mid_merit_gas') : null;
  const peakers = visibleSeries.has('peaking_gas') ? seriesValues(timeline, 'peaking_gas') : null;
  const bat = visibleSeries.has('battery_discharging') ? seriesValues(timeline, 'battery_discharging') : null;
  const hydro = visibleSeries.has('hydro') ? seriesValues(timeline, 'hydro') : null;

  const midSum = mid ? new Float64Array(NUM_BUCKETS) : null;
  const peakersSum = peakers ? new Float64Array(NUM_BUCKETS) : null;
  const batSum = bat ? new Float64Array(NUM_BUCKETS) : null;
  const hydroSum = hydro ? new Float64Array(NUM_BUCKETS) : null;

  const midTotal = mid ? new Float32Array(numFrames) : null;
  const peakersTotal = peakers ? new Float32Array(numFrames) : null;
  const batTotal = bat ? new Float32Array(numFrames) : null;
  const hydroTotal = hydro ? new Float32Array(numFrames) : null;
  let maxStackedBucket = 0;

  const startWalk = Math.max(0, firstFrame - windowDays + 1);
  for (let f = startWalk; f <= lastFrame; f++) {
    const offIn = f * NUM_BUCKETS;
    for (let b = 0; b < NUM_BUCKETS; b++) {
      if (midSum && mid) midSum[b] += mid[offIn + b];
      if (peakersSum && peakers) peakersSum[b] += peakers[offIn + b];
      if (batSum && bat) batSum[b] += bat[offIn + b];
      if (hydroSum && hydro) hydroSum[b] += hydro[offIn + b];
    }
    if (f - startWalk >= windowDays) {
      const offOut = (f - windowDays) * NUM_BUCKETS;
      for (let b = 0; b < NUM_BUCKETS; b++) {
        if (midSum && mid) midSum[b] -= mid[offOut + b];
        if (peakersSum && peakers) peakersSum[b] -= peakers[offOut + b];
        if (batSum && bat) batSum[b] -= bat[offOut + b];
        if (hydroSum && hydro) hydroSum[b] -= hydro[offOut + b];
      }
    }
    if (f >= firstFrame) {
      const samplesInWindow = Math.min(windowDays, f - startWalk + 1);
      let totalMid = 0;
      let totalPeakers = 0;
      let totalBat = 0;
      let totalHydro = 0;
      let frameMax = 0;
      for (let b = 0; b < NUM_BUCKETS; b++) {
        const m = midSum ? midSum[b] / samplesInWindow : 0;
        const p = peakersSum ? peakersSum[b] / samplesInWindow : 0;
        const ba = batSum ? batSum[b] / samplesInWindow : 0;
        const h = hydroSum ? hydroSum[b] / samplesInWindow : 0;
        totalMid += m;
        totalPeakers += p;
        totalBat += ba;
        totalHydro += h;
        const stacked = m + p + ba + h;
        if (stacked > frameMax) frameMax = stacked;
      }
      if (midTotal) midTotal[f] = totalMid / NUM_BUCKETS;
      if (peakersTotal) peakersTotal[f] = totalPeakers / NUM_BUCKETS;
      if (batTotal) batTotal[f] = totalBat / NUM_BUCKETS;
      if (hydroTotal) hydroTotal[f] = totalHydro / NUM_BUCKETS;
      if (frameMax > maxStackedBucket) maxStackedBucket = frameMax;
    }
  }
  return { midMeritTotal: midTotal, peakersTotal, batTotal, hydroTotal, maxStackedBucket };
}

export type CompareMode =
  | { kind: 'yearsAgo'; years: number }
  | { kind: 'avgYears'; fromYear: number; toYear: number };

type CmpRange = {
  offsetYears: number;
  /** Calendar year of the comparison window's "to" date (toYear − offsetYears). */
  year: number;
  /** Frame index of the requested first day, clamped to [0, numDays−1]. */
  firstFrame: number;
  /** Frame index of the requested last day, clamped to [0, numDays−1]. */
  lastFrame: number;
  /** True iff the unclamped requested range fits inside the timeline. */
  hasFullData: boolean;
};

function modeToOffsets(mode: CompareMode, toDate: string): number[] {
  if (mode.kind === 'yearsAgo') return [mode.years];
  const toYear = Number(toDate.slice(0, 4));
  const offsets: number[] = [];
  for (let y = mode.toYear; y >= mode.fromYear; y--) offsets.push(toYear - y);
  return offsets;
}

/**
 * Per-range computeAggregates, then average per-frame totals onto [userFirst..userLast].
 * Each user frame f maps to range k's frame f − (userFirst − cmpRanges[k].firstFrame).
 * `maxStackedBucket` is max-of-maxes across ranges (safe upper bound for the shared y-axis).
 */
function computeAveragedAggregates(
  timeline: Timeline,
  windowDays: number,
  cmpRanges: CmpRange[],
  visibleSeries: Set<TodSeriesKey>,
  userFirst: number,
  userLast: number,
): TimelineAggregates | null {
  if (cmpRanges.length === 0) return null;
  const perRange = cmpRanges.map((r) =>
    computeAggregates(timeline, windowDays, r.firstFrame, r.lastFrame, visibleSeries),
  );
  const numFrames = timeline.numDays;
  const useMid = perRange.some((a) => a.midMeritTotal !== null);
  const usePeakers = perRange.some((a) => a.peakersTotal !== null);
  const useBat = perRange.some((a) => a.batTotal !== null);
  const useHydro = perRange.some((a) => a.hydroTotal !== null);
  const midTotal = useMid ? new Float32Array(numFrames) : null;
  const peakersTotal = usePeakers ? new Float32Array(numFrames) : null;
  const batTotal = useBat ? new Float32Array(numFrames) : null;
  const hydroTotal = useHydro ? new Float32Array(numFrames) : null;
  const N = cmpRanges.length;
  for (let f = userFirst; f <= userLast; f++) {
    let mid = 0,
      pk = 0,
      ba = 0,
      hy = 0;
    for (let k = 0; k < N; k++) {
      const cmpF = f - (userFirst - cmpRanges[k].firstFrame);
      if (cmpF < 0 || cmpF >= numFrames) continue;
      const a = perRange[k];
      if (a.midMeritTotal) mid += a.midMeritTotal[cmpF];
      if (a.peakersTotal) pk += a.peakersTotal[cmpF];
      if (a.batTotal) ba += a.batTotal[cmpF];
      if (a.hydroTotal) hy += a.hydroTotal[cmpF];
    }
    if (midTotal) midTotal[f] = mid / N;
    if (peakersTotal) peakersTotal[f] = pk / N;
    if (batTotal) batTotal[f] = ba / N;
    if (hydroTotal) hydroTotal[f] = hy / N;
  }
  let maxStackedBucket = 0;
  for (const a of perRange) {
    if (a.maxStackedBucket > maxStackedBucket) maxStackedBucket = a.maxStackedBucket;
  }
  return { midMeritTotal: midTotal, peakersTotal, batTotal, hydroTotal, maxStackedBucket };
}

const FPS = 30;
const FRAME_MS = 1000 / FPS;

function shiftYears(s: string, years: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return ymd(d);
}
function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function formatDateNice(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function formatDateShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} '${yy}`;
}

// Must match TodChart and TodTimelineSummary so the slider track lines up with the chart x-axis.
// Charts are rendered at measured CSS pixel width with fixed pixel margins; the slider
// shares the same flex-column container so identical pixel padding aligns the two.
const CHART_MARGIN_LEFT = 64;
const CHART_MARGIN_RIGHT = 24;

export function TodAnimatedView({
  region,
  visibleSeries,
  fromDate,
  toDate,
  windowDays,
  windowLabelShort,
  windowLabelLong,
  compareMode,
  initialFrameDate,
  chartHeight,
  summaryHeight,
  onFromDateChange,
  onToDateChange,
  onFrameDateChange,
}: {
  region: Region;
  visibleSeries: Set<TodSeriesKey>;
  fromDate: string;
  toDate: string;
  windowDays: number;
  /** e.g. "28d" or "12mo" */
  windowLabelShort: string;
  /** e.g. "28-day rolling" or "12-month rolling" */
  windowLabelLong: string;
  /** If set, render an extra chart with the comparison series. */
  compareMode?: CompareMode;
  /** ISO date for initial slider position (preserved across view switches). */
  initialFrameDate?: string;
  chartHeight?: number;
  summaryHeight?: number;
  onFromDateChange: (iso: string) => void;
  onToDateChange: (iso: string) => void;
  onFrameDateChange?: (date: string) => void;
}) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [frameIdx, setFrameIdx] = useState<number>(0);
  const [duration, setDuration] = useState<number>(6);
  const [durationText, setDurationText] = useState<string>('6');
  const [playing, setPlaying] = useState(false);
  const initialFrameDateRef = useRef(initialFrameDate);
  initialFrameDateRef.current = initialFrameDate;

  // Load (or re-use cached) static timeline for the active region.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    loadRegionTimeline(region)
      .then((tl) => {
        if (!cancelled) setTimeline(tl);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [region]);

  // User's selected frame range mapped onto the full timeline.
  const ranges = useMemo(() => {
    if (!timeline) return null;
    const userFirst = clamp(frameForDate(timeline, fromDate), 0, timeline.numDays - 1);
    const userLast = clamp(frameForDate(timeline, toDate), 0, timeline.numDays - 1);
    return { userFirst, userLast };
  }, [timeline, fromDate, toDate]);

  // One CmpRange per year-offset implied by `compareMode`. Empty when no comparison is requested.
  const cmpRanges = useMemo<CmpRange[]>(() => {
    if (!timeline || !compareMode) return [];
    const offsets = modeToOffsets(compareMode, toDate);
    const toYear = Number(toDate.slice(0, 4));
    return offsets.map((off) => {
      const reqFirst = frameForDate(timeline, shiftYears(fromDate, -off));
      const reqLast = frameForDate(timeline, shiftYears(toDate, -off));
      return {
        offsetYears: off,
        year: toYear - off,
        firstFrame: clamp(reqFirst, 0, timeline.numDays - 1),
        lastFrame: clamp(reqLast, 0, timeline.numDays - 1),
        hasFullData: reqFirst >= 0 && reqLast < timeline.numDays,
      };
    });
  }, [timeline, compareMode, fromDate, toDate]);

  // Initial slider position: prefer `initialFrameDate` (preserved across view switches),
  // falling back to "rightmost in user's range".
  useEffect(() => {
    if (!timeline || !ranges) return;
    const requested = initialFrameDateRef.current;
    let f: number;
    if (requested) {
      f = clamp(frameForDate(timeline, requested), ranges.userFirst, ranges.userLast);
    } else {
      f = ranges.userLast;
    }
    setFrameIdx(f);
    // Run on timeline ready or when the user's date range changes (e.g. view switch resets the bounds).
  }, [timeline, ranges]);

  useEffect(() => {
    if (timeline && onFrameDateChange) onFrameDateChange(frameDate(timeline, frameIdx));
  }, [timeline, frameIdx, onFrameDateChange]);

  // Autoplay
  useEffect(() => {
    if (!playing || !timeline || !ranges) return;
    const startTs = performance.now();
    const startFrame = frameIdx >= ranges.userLast ? ranges.userFirst : frameIdx;
    const totalMs = duration * 1000;
    const span = ranges.userLast - startFrame;
    if (span <= 0) {
      setPlaying(false);
      return;
    }
    setFrameIdx(startFrame);
    const id = setInterval(() => {
      const elapsed = performance.now() - startTs;
      if (elapsed >= totalMs) {
        setFrameIdx(ranges.userLast);
        setPlaying(false);
        return;
      }
      const f = startFrame + Math.floor((elapsed / totalMs) * span);
      setFrameIdx(f);
    }, FRAME_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, timeline, duration, ranges]);

  const aggregates = useMemo(() => {
    if (!timeline || !ranges) return null;
    return computeAggregates(timeline, windowDays, ranges.userFirst, ranges.userLast, visibleSeries);
  }, [timeline, windowDays, ranges, visibleSeries]);
  const aggregatesCmp = useMemo(() => {
    if (!timeline || !ranges || cmpRanges.length === 0) return null;
    return computeAveragedAggregates(
      timeline,
      windowDays,
      cmpRanges,
      visibleSeries,
      ranges.userFirst,
      ranges.userLast,
    );
  }, [timeline, windowDays, ranges, cmpRanges, visibleSeries]);

  // Chart frames: filtered by the toggles so visibility changes without re-loading.
  const filterSeries = (all: ReturnType<typeof computeRollingFrame>) =>
    all.filter((s) => visibleSeries.has(s.fueltech));
  const series = useMemo(() => {
    if (!timeline) return [];
    return filterSeries(computeRollingFrame(timeline, frameIdx, windowDays));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, frameIdx, windowDays, visibleSeries]);
  const seriesCmp = useMemo(() => {
    if (!timeline || !ranges || cmpRanges.length === 0) return [];
    const cmpFrames = cmpRanges.map((r) => frameIdx - (ranges.userFirst - r.firstFrame));
    return filterSeries(computeAveragedRollingFrame(timeline, cmpFrames, windowDays));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, frameIdx, windowDays, visibleSeries, ranges, cmpRanges]);

  const sharedYMax = useMemo(() => {
    const a = aggregates?.maxStackedBucket ?? 0;
    const b = aggregatesCmp?.maxStackedBucket ?? 0;
    return Math.max(a, b);
  }, [aggregates, aggregatesCmp]);

  const sliderMin = ranges?.userFirst ?? 0;
  const sliderMax = ranges?.userLast ?? 0;
  const currentDate = timeline ? frameDate(timeline, frameIdx) : fromDate;
  // Only meaningful for the single-year ('yearsAgo') mode; the avg mode uses 10 different cmp dates.
  const cmpCurrentDate =
    timeline && ranges && cmpRanges.length === 1
      ? frameDate(timeline, frameIdx - (ranges.userFirst - cmpRanges[0].firstFrame))
      : '';
  const cmpChartTitle = (() => {
    if (!compareMode) return '';
    if (compareMode.kind === 'yearsAgo') {
      return `Same period ${compareMode.years} years ago · ${windowLabelShort} ending ${formatDateNice(cmpCurrentDate)}`;
    }
    return `Average of ${compareMode.fromYear}–${compareMode.toYear} · ${windowLabelShort} ending same calendar day each year`;
  })();
  const cmpIncompleteYears = cmpRanges.filter((r) => !r.hasFullData).map((r) => r.year);

  // CSV export wiring for the comparison series. Captured locals carry the non-null narrowing
  // into the returned closures (TS won't propagate guards into nested lambdas).
  const cmpExportConfig = useMemo<CmpExportConfig | undefined>(() => {
    if (!timeline || !compareMode || !ranges || cmpRanges.length === 0) return undefined;
    const tl = timeline;
    const r = ranges;
    const m = compareMode;
    const cs = cmpRanges;
    return {
      cmpFramesFor: (f) => cs.map((cr) => f - (r.userFirst - cr.firstFrame)),
      labelFor: (f) => {
        if (m.kind === 'yearsAgo') {
          return frameDate(tl, f - (r.userFirst - cs[0].firstFrame));
        }
        const mmdd = frameDate(tl, f).slice(5);
        return `[${m.fromYear}-${m.toYear}]-${mmdd}`;
      },
    };
  }, [timeline, compareMode, ranges, cmpRanges]);
  const cmpFileSuffix = compareMode
    ? compareMode.kind === 'yearsAgo'
      ? `-cmp-${compareMode.years}y`
      : `-cmp-avg-${compareMode.fromYear}-${compareMode.toYear}`
    : '';

  return (
    <div className="flex flex-col gap-4">
      {/* Cohesive controls panel: top row of controls + a date slider whose
          track padding (64px / 24px) matches the chart's left/right margins so
          the thumb's position lines up with the chart x-axis below. */}
      <div className="rounded-lg bg-zinc-100 dark:bg-zinc-800/40">
        <div className="flex flex-wrap items-center gap-4 px-4 py-3">
          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <span>From</span>
            <DateInput value={fromDate} onChange={onFromDateChange} maxDate={toDate} />
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <span>To</span>
            <DateInput value={toDate} onChange={onToDateChange} minDate={fromDate} />
          </label>

          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input
              type="text"
              inputMode="numeric"
              value={durationText}
              onChange={(e) => setDurationText(e.target.value)}
              onBlur={() => {
                const parsed = Number.parseInt(durationText.trim(), 10);
                const clamped = Number.isFinite(parsed) ? Math.max(5, parsed) : 30;
                setDuration(clamped);
                setDurationText(String(clamped));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
              }}
              className="w-16 rounded border border-zinc-300 bg-white px-2 py-1 text-right tabular-nums dark:border-zinc-600 dark:bg-zinc-900 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-zinc-500">s @ {FPS} fps</span>
          </label>

          <button
            type="button"
            className="ml-auto rounded border border-zinc-300 bg-white px-3 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-900"
            disabled={!timeline}
            onClick={() => {
              if (!timeline || !ranges) return;
              if (frameIdx >= ranges.userLast) setFrameIdx(ranges.userFirst);
              setPlaying((p) => !p);
            }}
          >
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>

        </div>

        {timeline && ranges && (
          <div
            className="flex flex-col gap-1 pb-3"
            style={{ paddingLeft: CHART_MARGIN_LEFT, paddingRight: CHART_MARGIN_RIGHT + 24 }}
          >
            {(() => {
              const sliderValue = Math.max(sliderMin, Math.min(sliderMax, frameIdx));
              const pct =
                sliderMax > sliderMin
                  ? ((sliderValue - sliderMin) / (sliderMax - sliderMin)) * 100
                  : 0;
              return (
                <div className="relative h-7">
                  <input
                    type="range"
                    min={sliderMin}
                    max={sliderMax}
                    step={1}
                    value={sliderValue}
                    disabled={!timeline}
                    onChange={(e) => {
                      setPlaying(false);
                      setFrameIdx(Number.parseInt(e.target.value, 10));
                    }}
                    className="tod-pill-slider absolute inset-0"
                    style={{ ['--tod-pct' as string]: `${pct}%` } as CSSProperties}
                  />
                  <div
                    aria-hidden="true"
                    className="absolute top-1/2 pointer-events-none rounded-md bg-blue-500 px-2 py-0.5 text-xs font-medium text-white shadow tabular-nums whitespace-nowrap"
                    style={{ left: `${pct}%`, transform: 'translate(-50%, -50%)' }}
                  >
                    {formatDateShort(currentDate)}
                  </div>
                </div>
              );
            })()}
            <div className="flex justify-between text-xs text-zinc-500 tabular-nums">
              <span>{formatDateShort(frameDate(timeline, sliderMin))}</span>
              <span>{formatDateShort(frameDate(timeline, sliderMax))}</span>
            </div>
          </div>
        )}
      </div>

      {loadError && <p className="text-sm text-red-600">Error loading timeline: {loadError}</p>}
      {timeline && aggregates && ranges ? (
        <>
          <TodChart
            series={series}
            yDomainOverride={sharedYMax || aggregates.maxStackedBucket}
            title={`Time-of-day generation profile · ${windowLabelShort} ending ${formatDateNice(currentDate)}`}
            {...(chartHeight !== undefined && { height: chartHeight })}
          />
          {compareMode !== undefined && aggregatesCmp && (
            <>
              <TodChart
                series={seriesCmp}
                yDomainOverride={sharedYMax || aggregatesCmp.maxStackedBucket}
                title={cmpChartTitle}
                {...(chartHeight !== undefined && { height: chartHeight })}
              />
              {cmpIncompleteYears.length > 0 && (
                <p className="-mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  Comparison data incomplete for {cmpIncompleteYears.join(', ')}.
                </p>
              )}
            </>
          )}

          <TodTimelineSummary
            startDate={timeline.startDate}
            numDays={timeline.numDays}
            midMeritTotal={aggregates.midMeritTotal}
            peakersTotal={aggregates.peakersTotal}
            batTotal={aggregates.batTotal}
            hydroTotal={aggregates.hydroTotal}
            minFrame={sliderMin}
            maxFrame={sliderMax}
            currentFrame={frameIdx}
            title={`Mean MW · ${windowLabelLong}, by date`}
            {...(summaryHeight !== undefined && { height: summaryHeight })}
            onFrameChange={(f) => {
              setPlaying(false);
              setFrameIdx(Math.max(sliderMin, Math.min(sliderMax, f)));
            }}
          />
          <div
            className="flex flex-wrap items-center justify-between gap-2"
            style={{ paddingRight: CHART_MARGIN_RIGHT }}
          >
            <DataAttribution />
            <div className="flex flex-wrap items-center gap-2">
              <ExportCsvButton
                label="Export Full Series"
                filename={`tod-${region}-${windowLabelShort}-${fromDate}-${toDate}${cmpFileSuffix}.csv`}
                rowCount={(ranges.userLast - ranges.userFirst + 1) * timeline.numBuckets}
                getCsv={() =>
                  buildRollingCsv(
                    timeline,
                    ranges.userFirst,
                    ranges.userLast,
                    windowDays,
                    visibleSeries,
                    cmpExportConfig,
                  )
                }
              />
              <ExportCsvButton
                label="Export Current Frame"
                filename={`tod-${region}-${windowLabelShort}-frame-${currentDate}${cmpFileSuffix}.csv`}
                rowCount={timeline.numBuckets}
                getCsv={() =>
                  buildRollingCsv(
                    timeline,
                    frameIdx,
                    frameIdx,
                    windowDays,
                    visibleSeries,
                    cmpExportConfig,
                  )
                }
              />
            </div>
          </div>
        </>
      ) : (
        <div className="h-[480px] grid place-items-center text-sm text-zinc-500">
          loading timeline (~250ms after first load)…
        </div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
