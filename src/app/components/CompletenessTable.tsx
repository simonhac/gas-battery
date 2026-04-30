import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataAttribution } from './DataAttribution';

type CompletenessData = {
  generatedAt: string;
  minYear: number;
  maxYear: number;
  regions: string[];
  fueltechs: string[];
  rows: { region: string; fueltech: string; byYear: Record<string, number> }[];
};

const FUELTECH_LABEL: Record<string, string> = {
  gas_ccgt: 'Gas (CCGT)',
  gas_ocgt: 'Gas (OCGT)',
  gas_recip: 'Gas (Recip)',
  gas_steam: 'Gas (Steam)',
  gas_wcmg: 'Gas (WCMG)',
  battery_discharging: 'Battery (discharging)',
  hydro: 'Hydro',
};

const REGION_COL_WIDTH = '5rem';
const TECH_COL_WIDTH = '11rem';
const YEAR_COL_WIDTH = '5rem';

function loadData(): CompletenessData {
  const path = join(process.cwd(), 'public', 'data', 'completeness.json');
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as CompletenessData;
}

function cellClasses(ratio: number | undefined): string {
  if (ratio === undefined) {
    return 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800/40 dark:text-zinc-500';
  }
  if (ratio >= 0.99) return 'bg-emerald-500/35 text-emerald-950 dark:bg-emerald-400/30 dark:text-emerald-50';
  if (ratio >= 0.95) return 'bg-green-400/35 text-green-950 dark:bg-green-400/25 dark:text-green-50';
  if (ratio >= 0.8) return 'bg-yellow-300/60 text-yellow-950 dark:bg-yellow-400/25 dark:text-yellow-50';
  if (ratio >= 0.5) return 'bg-orange-400/50 text-orange-950 dark:bg-orange-400/30 dark:text-orange-50';
  if (ratio > 0) return 'bg-red-500/45 text-red-950 dark:bg-red-500/35 dark:text-red-50';
  return 'bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500';
}

function formatPct(ratio: number | undefined): string {
  if (ratio === undefined) return '—';
  if (ratio === 0) return '0%';
  if (ratio >= 0.999) return '100%';
  return `${(ratio * 100).toFixed(1)}%`;
}

export function CompletenessTable() {
  const data = loadData();
  const years: number[] = [];
  for (let y = data.minYear; y <= data.maxYear; y++) years.push(y);

  const rowsByRegion = new Map<string, typeof data.rows>();
  for (const row of data.rows) {
    let list = rowsByRegion.get(row.region);
    if (!list) {
      list = [];
      rowsByRegion.set(row.region, list);
    }
    list.push(row);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Percentage of expected 5-minute samples present in <code className="font-mono text-xs">power_5m</code>{' '}
        for each year, region, and fueltech. Expected = 288 buckets/day × days in calendar year. Year boundaries
        use each region&apos;s market timezone (NEM → AEST, WEM → AWST). Generated{' '}
        {new Date(data.generatedAt).toLocaleString('en-AU', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}
        .
      </p>

      <div className="overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800 max-h-[80vh] shadow-sm">
        <table className="border-collapse text-sm" style={{ tableLayout: 'fixed', minWidth: 'max-content' }}>
          <colgroup>
            <col style={{ width: REGION_COL_WIDTH }} />
            <col style={{ width: TECH_COL_WIDTH }} />
            {years.map((y) => (
              <col key={y} style={{ width: YEAR_COL_WIDTH }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky top-0 left-0 z-30 px-3 py-2 text-left font-semibold text-zinc-700 dark:text-zinc-200 bg-zinc-100 dark:bg-zinc-900 border-b border-r border-zinc-200 dark:border-zinc-800"
                style={{ width: REGION_COL_WIDTH }}
              >
                Region
              </th>
              <th
                scope="col"
                className="sticky top-0 z-20 px-3 py-2 text-left font-semibold text-zinc-700 dark:text-zinc-200 bg-zinc-100 dark:bg-zinc-900 border-b border-r border-zinc-200 dark:border-zinc-800"
                style={{ left: REGION_COL_WIDTH, width: TECH_COL_WIDTH }}
              >
                Fueltech
              </th>
              {years.map((y) => (
                <th
                  key={y}
                  scope="col"
                  className="sticky top-0 z-10 px-3 py-2 text-center font-semibold text-zinc-700 dark:text-zinc-200 bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 tabular-nums"
                >
                  {y}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.regions.map((region, regionIdx) => {
              const regionRows = rowsByRegion.get(region) ?? [];
              const isLastRegion = regionIdx === data.regions.length - 1;
              return regionRows.map((row, idxInRegion) => {
                const isLastInRegion = idxInRegion === regionRows.length - 1;
                const groupBorder = isLastInRegion && !isLastRegion ? 'border-b-2 border-b-zinc-300 dark:border-b-zinc-700' : 'border-b border-zinc-200 dark:border-zinc-800';
                return (
                  <tr key={`${region}-${row.fueltech}`}>
                    {idxInRegion === 0 && (
                      <th
                        scope="rowgroup"
                        rowSpan={regionRows.length}
                        className="sticky left-0 z-10 px-3 py-2 align-top text-left text-base font-semibold text-zinc-900 dark:text-zinc-50 bg-white dark:bg-zinc-950 border-b-2 border-r border-zinc-300 dark:border-zinc-700"
                        style={{ width: REGION_COL_WIDTH }}
                      >
                        {region}
                      </th>
                    )}
                    <th
                      scope="row"
                      className={`sticky z-10 px-3 py-1.5 text-left font-medium text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-950 border-r border-zinc-200 dark:border-zinc-800 whitespace-nowrap ${groupBorder}`}
                      style={{ left: REGION_COL_WIDTH, width: TECH_COL_WIDTH }}
                    >
                      {FUELTECH_LABEL[row.fueltech] ?? row.fueltech}
                    </th>
                    {years.map((y) => {
                      const ratio = row.byYear[String(y)];
                      return (
                        <td
                          key={y}
                          className={`px-3 py-1.5 text-center text-xs tabular-nums ${groupBorder} ${cellClasses(ratio)}`}
                        >
                          {formatPct(ratio)}
                        </td>
                      );
                    })}
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Legend />
        <DataAttribution />
      </div>
    </div>
  );
}

function Legend() {
  const stops: { label: string; ratio: number | undefined }[] = [
    { label: '≥ 99%', ratio: 1 },
    { label: '≥ 95%', ratio: 0.96 },
    { label: '≥ 80%', ratio: 0.85 },
    { label: '≥ 50%', ratio: 0.6 },
    { label: '> 0%', ratio: 0.1 },
    { label: '0%', ratio: 0 },
    { label: 'no data', ratio: undefined },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
      <span className="font-medium">Legend:</span>
      {stops.map((s) => (
        <span
          key={s.label}
          className={`px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 tabular-nums ${cellClasses(s.ratio)}`}
        >
          {s.label}
        </span>
      ))}
    </div>
  );
}
