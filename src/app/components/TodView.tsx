'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { TodSmallMultiples } from './TodSmallMultiples';
import { TodAnimatedView, type CompareMode } from './TodAnimatedView';
import { REGIONS, type Region } from '@/lib/regions';
import type { TodSeriesKey } from '@/lib/tod/timeline-client';

const SERIES_ORDER: TodSeriesKey[] = [
  'battery_discharging',
  'mid_merit_gas',
  'peaking_gas',
  'hydro',
];

type SeriesLegend = { name: string; sub?: string; color: string };
const SERIES_LEGEND: Record<TodSeriesKey, SeriesLegend> = {
  mid_merit_gas: { name: 'mid-merit gas', sub: '(CCGT + steam + WCMG)', color: '#9a3412' },
  peaking_gas: { name: 'peaking gas', sub: '(OCGT + reciprocating)', color: '#f97316' },
  battery_discharging: { name: 'battery discharging', color: '#4f46e5' },
  hydro: { name: 'hydro', color: '#0d9488' },
};

// URL params: each series gets one. mid-merit defaults OFF (writes 'midMerit=on'),
// the others default ON (write 'peaking=off' / 'battery=off' / 'hydro=off').
const SERIES_URL_KEY: Record<TodSeriesKey, string> = {
  mid_merit_gas: 'midMerit',
  peaking_gas: 'peaking',
  battery_discharging: 'battery',
  hydro: 'hydro',
};
const SERIES_DEFAULT_VISIBLE: Record<TodSeriesKey, boolean> = {
  mid_merit_gas: false,
  peaking_gas: true,
  battery_discharging: true,
  hydro: true,
};

const VIEW_MODES = ['28d', '12mo', 'years'] as const;
type ViewMode = (typeof VIEW_MODES)[number];

const COMPARE_KEYS = ['3y', '5y', '10y', 'avg2012_2022'] as const;
type CompareKey = (typeof COMPARE_KEYS)[number];

const COMPARE_LABELS: Record<CompareKey, string> = {
  '3y': '3 years prior',
  '5y': '5 years prior',
  '10y': '10 years prior',
  avg2012_2022: 'Average of 2012–2022',
};

function compareKeyToMode(key: CompareKey): CompareMode {
  switch (key) {
    case '3y':
      return { kind: 'yearsAgo', years: 3 };
    case '5y':
      return { kind: 'yearsAgo', years: 5 };
    case '10y':
      return { kind: 'yearsAgo', years: 10 };
    case 'avg2012_2022':
      return { kind: 'avgYears', fromYear: 2012, toYear: 2022 };
  }
}

// Defaults per view (URL-overridable).
const DEFAULTS = {
  '28d': { from: '2025-04-30', to: '2026-04-30' },
  // 12mo from = first day of data; the year-leading-up window fills in as the slider moves.
  '12mo': { from: '2017-12-01', to: '2026-04-30' },
} as const;

export function TodView() {
  const searchParams = useSearchParams();

  const [region, setRegion] = useState<Region>(
    (searchParams.get('region') as Region) ?? 'NEM',
  );
  const [visibleSeries, setVisibleSeries] = useState<Set<TodSeriesKey>>(() => {
    const set = new Set<TodSeriesKey>();
    for (const key of SERIES_ORDER) {
      const param = searchParams.get(SERIES_URL_KEY[key]);
      const visible =
        param === 'on' ? true : param === 'off' ? false : SERIES_DEFAULT_VISIBLE[key];
      if (visible) set.add(key);
    }
    return set;
  });
  // Toggling a series; if doing so would hide every series, instead show all.
  const toggleSeries = (key: TodSeriesKey) => {
    setVisibleSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (next.size === 0) return new Set<TodSeriesKey>(SERIES_ORDER);
      return next;
    });
  };
  const viewParam = searchParams.get('view');
  const view: ViewMode =
    viewParam === '28d' || viewParam === 'years' || viewParam === '12mo' ? viewParam : '28d';
  // Comparison mode for the 28-day view's middle chart (5y prior preserves prior behavior).
  const [compareKey, setCompareKey] = useState<CompareKey>(() => {
    const v = searchParams.get('compare');
    return v === '3y' || v === '5y' || v === '10y' || v === 'avg2012_2022' ? v : '5y';
  });

  // Per-view date-range state (each view can have its own from/to).
  const [from28d, setFrom28d] = useState<string>(
    searchParams.get('from28d') ?? DEFAULTS['28d'].from,
  );
  const [to28d, setTo28d] = useState<string>(
    searchParams.get('to28d') ?? DEFAULTS['28d'].to,
  );
  const [from12mo, setFrom12mo] = useState<string>(
    searchParams.get('from12mo') ?? DEFAULTS['12mo'].from,
  );
  const [to12mo, setTo12mo] = useState<string>(
    searchParams.get('to12mo') ?? DEFAULTS['12mo'].to,
  );

  // Current windowEnd (date the slider points at) — preserved across view changes.
  const [windowEnd, setWindowEnd] = useState<string>(
    searchParams.get('windowEnd') ?? to28d,
  );

  // URL sync (debounced). Use the History API directly: router.replace() with the App Router
  // re-runs `useSearchParams` consumers (this component) on every call, which would cause an
  // infinite loop here. window.history.replaceState updates the URL without any React work.
  const urlTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (urlTimer.current) clearTimeout(urlTimer.current);
    urlTimer.current = setTimeout(() => {
      const params = new URLSearchParams();
      params.set('region', region);
      for (const key of SERIES_ORDER) {
        const visible = visibleSeries.has(key);
        if (visible !== SERIES_DEFAULT_VISIBLE[key]) {
          params.set(SERIES_URL_KEY[key], visible ? 'on' : 'off');
        }
      }
      if (view !== '28d') params.set('view', view);
      if (view !== 'years') params.set('windowEnd', windowEnd);
      if (from28d !== DEFAULTS['28d'].from) params.set('from28d', from28d);
      if (to28d !== DEFAULTS['28d'].to) params.set('to28d', to28d);
      if (from12mo !== DEFAULTS['12mo'].from) params.set('from12mo', from12mo);
      if (to12mo !== DEFAULTS['12mo'].to) params.set('to12mo', to12mo);
      if (view === '28d' && compareKey !== '5y') params.set('compare', compareKey);
      const next = `${window.location.pathname}?${params.toString()}`;
      const current = `${window.location.pathname}${window.location.search}`;
      if (next !== current) window.history.replaceState(null, '', next);
    }, 200);
    return () => {
      if (urlTimer.current) clearTimeout(urlTimer.current);
    };
  }, [region, visibleSeries, view, windowEnd, from28d, to28d, from12mo, to12mo, compareKey]);

  return (
    <div className="flex flex-col gap-4">
      {/* Top-level controls (region, comparison). View mode is selected via the top nav. */}
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Region</span>
          <select
            className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
            value={region}
            onChange={(e) => setRegion(e.target.value as Region)}
          >
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        {view === '28d' && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Comparison</span>
            <select
              className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              value={compareKey}
              onChange={(e) => setCompareKey(e.target.value as CompareKey)}
            >
              {COMPARE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {COMPARE_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Legend / series toggles. Click a swatch to toggle that series. Turning off the last
          visible series turns them all back on. */}
      <div className="@container">
        <div className="flex flex-col @5xl:flex-row @5xl:flex-wrap @5xl:items-center @5xl:justify-between gap-4 text-base text-zinc-700 dark:text-zinc-300">
          {SERIES_ORDER.map((key) => {
            const { name, sub, color } = SERIES_LEGEND[key];
            const on = visibleSeries.has(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleSeries(key)}
                aria-pressed={on}
                title={on ? `Hide ${name}` : `Show ${name}`}
                className={`flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                  on ? '' : 'opacity-40'
                }`}
              >
                <span className="inline-block w-6 h-6 rounded-sm" style={{ background: color }} />
                <span>
                  {name}
                  {sub && (
                    <>
                      {' '}
                      <span className="text-zinc-500 dark:text-zinc-400">{sub}</span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {view === 'years' && (
        <TodSmallMultiples
          region={region}
          visibleSeries={visibleSeries}
          startYear={2018}
          endYear={new Date().getUTCFullYear()}
        />
      )}

      {view === '12mo' && (
        <TodAnimatedView
          region={region}
          visibleSeries={visibleSeries}
          fromDate={from12mo}
          toDate={to12mo}
          windowDays={365}
          windowLabelShort="12mo"
          windowLabelLong="12-month rolling"
          initialFrameDate={windowEnd}
          chartHeight={200}
          summaryHeight={200}
          onFromDateChange={setFrom12mo}
          onToDateChange={setTo12mo}
          onFrameDateChange={(d) => {
            if (d !== windowEnd) setWindowEnd(d);
          }}
        />
      )}

      {view === '28d' && (
        <TodAnimatedView
          region={region}
          visibleSeries={visibleSeries}
          fromDate={from28d}
          toDate={to28d}
          windowDays={28}
          windowLabelShort="28d"
          windowLabelLong="28-day rolling"
          compareMode={compareKeyToMode(compareKey)}
          initialFrameDate={windowEnd}
          chartHeight={200}
          summaryHeight={200}
          onFromDateChange={setFrom28d}
          onToDateChange={setTo28d}
          onFrameDateChange={(d) => {
            if (d !== windowEnd) setWindowEnd(d);
          }}
        />
      )}
    </div>
  );
}

