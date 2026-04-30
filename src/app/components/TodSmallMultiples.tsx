'use client';

import { useEffect, useMemo, useState } from 'react';
import { TodChart } from './TodChart';
import { ExportCsvButton } from './ExportCsvButton';
import { DataAttribution } from './DataAttribution';
import { buildYearsCsv } from '@/lib/tod/csv-export';
import {
  computeRollingFrame,
  frameForDate,
  loadRegionTimeline,
  type Timeline,
  type TodSeriesKey,
} from '@/lib/tod/timeline-client';
import { bucketToLowerLabel, formatSeriesShares } from '@/lib/tod/series-shares';

const TODAY_ISO = (() => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
})();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatNice(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

type YearTile = {
  year: number;
  windowEnd: string; // ISO date
  series: { fueltech: TodSeriesKey; buckets: number[] }[];
};

export function TodSmallMultiples({
  region,
  visibleSeries,
  startYear,
  endYear,
}: {
  region: string;
  visibleSeries: Set<TodSeriesKey>;
  startYear: number;
  endYear: number;
}) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoveredBucket, setHoveredBucket] = useState<number | null>(null);
  const [prevRegion, setPrevRegion] = useState(region);
  if (region !== prevRegion) {
    setPrevRegion(region);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    loadRegionTimeline(region)
      .then((tl) => {
        if (!cancelled) setTimeline(tl);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [region]);

  const tiles = useMemo<YearTile[] | null>(() => {
    if (!timeline) return null;
    const currentYear = new Date().getUTCFullYear();
    const out: YearTile[] = [];
    for (let year = startYear; year <= endYear; year++) {
      // Past years: 12mo window ending Jan 1 of next year (= rolls over the calendar year).
      // Current year: rolling 12 months ending today.
      const windowEnd = year === currentYear ? TODAY_ISO : `${year + 1}-01-01`;
      const frame = frameForDate(timeline, windowEnd);
      if (frame < 0 || frame >= timeline.numDays) continue;
      const all = computeRollingFrame(timeline, frame, 365);
      const series = all.filter((s) => visibleSeries.has(s.fueltech));
      out.push({ year, windowEnd, series });
    }
    return out;
  }, [timeline, startYear, endYear, visibleSeries]);

  if (error) return <p className="text-sm text-red-600">Error: {error}</p>;
  if (!tiles || !timeline) return <div className="grid place-items-center h-64 text-sm text-zinc-500">loading…</div>;

  // Shared y-axis: max stacked total across all years.
  let yMax = 0;
  for (const t of tiles) {
    for (let b = 0; b < 288; b++) {
      const sum = t.series.reduce((s, ft) => s + (ft.buckets[b] ?? 0), 0);
      if (sum > yMax) yMax = sum;
    }
  }

  const currentYear = new Date().getUTCFullYear();
  const exportFilename = `tod-${region}-years-${startYear}-${endYear}.csv`;
  const exportRowCount = tiles.length * 288;
  const onlyBattery =
    visibleSeries.size === 1 && visibleSeries.has('battery_discharging');
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-4">
        {tiles.map((t) => {
          const sharesText =
            hoveredBucket != null
              ? `${bucketToLowerLabel(hoveredBucket)}: ${formatSeriesShares(t.series, hoveredBucket)}`
              : formatSeriesShares(t.series);
          return (
            <div
              key={t.year}
              className="rounded border border-zinc-200 dark:border-zinc-800 p-2"
            >
              <div className="mb-1">
                <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {t.year === currentYear ? `12 mo to ${formatNice(t.windowEnd)}` : t.year}
                </div>
                {!onlyBattery && (
                  <div className="text-[11px] leading-tight text-zinc-500 dark:text-zinc-400 min-h-[1lh] truncate">
                    {sharesText}
                  </div>
                )}
              </div>
              <TodChart
                series={t.series}
                width={360}
                height={200}
                yDomainOverride={yMax}
                compact
                hoveredBucket={hoveredBucket}
                onHoverChange={setHoveredBucket}
              />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DataAttribution />
        <ExportCsvButton
          filename={exportFilename}
          rowCount={exportRowCount}
          getCsv={() => buildYearsCsv(timeline, tiles, visibleSeries)}
        />
      </div>
    </div>
  );
}
