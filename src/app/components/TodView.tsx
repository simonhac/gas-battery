'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { TodSmallMultiples } from './TodSmallMultiples';
import { TodAnimatedView, type CompareMode } from './TodAnimatedView';
import { REGIONS, type Region } from '@/lib/regions';
import { loadManifest, type Manifest, type TodSeriesKey } from '@/lib/tod/timeline-client';

const SERIES_ORDER: TodSeriesKey[] = [
  'battery_discharging',
  'peaking_gas',
  'mid_merit_gas',
  'hydro',
];

type SeriesLegend = { name: string; sub?: string; color: string };
const SERIES_LEGEND: Record<TodSeriesKey, SeriesLegend> = {
  mid_merit_gas: { name: 'mid-merit gas', sub: '(CCGT + steam + WCMG)', color: '#9a3412' },
  peaking_gas: { name: 'peaking gas', sub: '(OCGT + reciprocating)', color: '#f97316' },
  battery_discharging: { name: 'battery discharging', color: '#4f46e5' },
  hydro: { name: 'hydro', color: '#0d9488' },
};

// URL params: each series gets one. battery + peaking default ON; mid-merit + hydro default OFF.
// Only non-default values are written, so e.g. enabling hydro adds 'hydro=on'.
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
  hydro: false,
};

type ViewMode = '28d' | '12mo' | 'years';

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

function shiftDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Date defaults per view (URL-overridable), derived from the manifest so they follow the data
// forward on every refresh instead of being pinned to whenever this file was last edited.
type DateDefaults = { from28d: string; to28d: string; from12mo: string; to12mo: string };

// 12mo from = first big battery (Hornsdale); the year-leading-up window fills in as the slider
// moves. Genuinely fixed, unlike the end dates.
const FROM_12MO = '2017-12-01';

function defaultsFromManifest(manifest: Manifest): DateDefaults {
  // The manifest's last day is usually partial (the generator runs mid-day), so land on the
  // last complete day.
  const to = shiftDaysIso(manifest.endDate, -1);
  return { from28d: shiftDaysIso(to, -365), to28d: to, from12mo: FROM_12MO, to12mo: to };
}

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
  // Comparison mode for the 28-day view's middle chart.
  const [compareKey, setCompareKey] = useState<CompareKey>(() => {
    const v = searchParams.get('compare');
    return v === '3y' || v === '5y' || v === '10y' || v === 'avg2012_2022' ? v : 'avg2012_2022';
  });

  // Per-view date-range state (each view can have its own from/to). null until either the URL
  // supplied a value or the manifest has loaded and the defaults are known.
  const [defaults, setDefaults] = useState<DateDefaults | null>(null);
  const [from28d, setFrom28d] = useState<string | null>(searchParams.get('from28d'));
  const [to28d, setTo28d] = useState<string | null>(searchParams.get('to28d'));
  const [from12mo, setFrom12mo] = useState<string | null>(searchParams.get('from12mo'));
  const [to12mo, setTo12mo] = useState<string | null>(searchParams.get('to12mo'));

  // Current windowEnd (date the slider points at) — preserved across view changes.
  const [windowEnd, setWindowEnd] = useState<string | null>(searchParams.get('end'));

  // Fill in whatever the URL didn't specify, once the manifest says where the data ends. The
  // manifest is memoised and fetched anyway by the timeline loader, so this costs no extra request.
  useEffect(() => {
    let cancelled = false;
    loadManifest()
      .then((manifest) => {
        if (cancelled) return;
        const d = defaultsFromManifest(manifest);
        setDefaults(d);
        setFrom28d((v) => v ?? d.from28d);
        setTo28d((v) => v ?? d.to28d);
        setFrom12mo((v) => v ?? d.from12mo);
        setTo12mo((v) => v ?? d.to12mo);
        setWindowEnd((v) => v ?? searchParams.get('to28d') ?? d.to28d);
      })
      .catch(() => {
        // The chart surfaces manifest failures; nothing useful to default to here.
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  // URL sync (debounced). Use the History API directly: router.replace() with the App Router
  // re-runs `useSearchParams` consumers (this component) on every call, which would cause an
  // infinite loop here. window.history.replaceState updates the URL without any React work.
  useEffect(() => {
    if (!defaults || !from28d || !to28d || !from12mo || !to12mo || !windowEnd) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      params.set('region', region);
      for (const key of SERIES_ORDER) {
        const visible = visibleSeries.has(key);
        if (visible !== SERIES_DEFAULT_VISIBLE[key]) {
          params.set(SERIES_URL_KEY[key], visible ? 'on' : 'off');
        }
      }
      if (view !== '28d') params.set('view', view);
      if (view !== 'years') {
        const wd = view === '28d' ? 28 : 365;
        params.set('start', shiftDaysIso(windowEnd, -(wd - 1)));
        params.set('end', windowEnd);
      }
      if (from28d !== defaults.from28d) params.set('from28d', from28d);
      if (to28d !== defaults.to28d) params.set('to28d', to28d);
      if (from12mo !== defaults.from12mo) params.set('from12mo', from12mo);
      if (to12mo !== defaults.to12mo) params.set('to12mo', to12mo);
      if (view === '28d' && compareKey !== 'avg2012_2022') params.set('compare', compareKey);
      const next = `${window.location.pathname}?${params.toString()}`;
      const current = `${window.location.pathname}${window.location.search}`;
      if (next !== current) window.history.replaceState(null, '', next);
    }, 200);
    return () => clearTimeout(timer);
  }, [region, visibleSeries, view, windowEnd, from28d, to28d, from12mo, to12mo, compareKey, defaults]);

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

      {view === '12mo' && from12mo && to12mo && windowEnd && (
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

      {view === '28d' && from28d && to28d && windowEnd && (
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

