'use client';

import { area, scaleLinear, stack, max as d3max } from 'd3';
import { TOD_BUCKETS_PER_DAY } from '@/lib/time/tod';
import { useContainerWidth } from '@/lib/use-container-width';
import type { TodSeriesKey } from '@/lib/tod/timeline-client';

export type TodSeries = { fueltech: TodSeriesKey | string; buckets: number[] };

const COLOURS: Record<string, string> = {
  mid_merit_gas: '#9a3412', // orange-800 — mid-merit (CCGT/steam/WCMG)
  peaking_gas: '#f97316', // orange-500 — peakers (OCGT/recip)
  battery_discharging: '#4f46e5', // indigo — battery discharging
  hydro: '#0d9488', // teal-600 — hydro
};

const HOUR_TICKS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

export function TodChart({
  series,
  width = 1100,
  height = 480,
  yDomainOverride,
  compact = false,
  showYTicks = true,
  showXTicks = true,
  title,
}: {
  series: TodSeries[];
  width?: number;
  height?: number;
  /** If set, force this y-axis maximum (e.g. for small-multiples shared scale). */
  yDomainOverride?: number;
  /** Smaller margins + smaller fonts for grid use. */
  compact?: boolean;
  showYTicks?: boolean;
  showXTicks?: boolean;
  title?: string;
}) {
  // `width` is the SSR/initial render fallback; once mounted the wrapper div's
  // measured CSS width takes over so the SVG renders at exact pixel size and
  // height stays fixed while width follows the page.
  const [measuredWidth, containerRef] = useContainerWidth(width);
  const margin = compact
    ? { top: 8, right: 8, bottom: 18, left: showYTicks ? 36 : 6 }
    // 56 px when titled matches TodTimelineSummary's gap, which is sized to clear
    // its frame-indicator pill. Keeping the gap consistent across charts.
    : { top: title ? 56 : 12, right: 24, bottom: 28, left: 64 };
  const innerW = measuredWidth - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const buckets = Array.from({ length: TOD_BUCKETS_PER_DAY }, (_, i) => i);
  const fueltechs = series.map((s) => s.fueltech);
  const data = buckets.map((b) => {
    const row: Record<string, number> = { bucket: b };
    for (const s of series) row[s.fueltech] = s.buckets[b];
    return row;
  });

  const stacker = stack<Record<string, number>>().keys(fueltechs);
  const stackedSeries = stacker(data); // one entry per fueltech, each is array of [y0, y1]

  const yMax = d3max(stackedSeries.flat(), (d) => d[1]) ?? 0;

  const x = scaleLinear().domain([0, TOD_BUCKETS_PER_DAY - 1]).range([0, innerW]);
  const y = scaleLinear()
    .domain([0, yDomainOverride ?? yMax])
    .range([innerH, 0])
    .nice();
  const yDomainMax = y.domain()[1];

  const a = area<[number, number]>()
    .x((_d, i) => x(i))
    .y0((d) => y(d[0]))
    .y1((d) => y(d[1]));

  const yTicks = y.ticks(compact ? 3 : 5);
  const fontSize = compact ? 10 : 12;

  return (
    <div ref={containerRef} className="w-full">
      <svg
        width={measuredWidth}
        height={height}
        className="font-sans block"
      >
      {title && !compact && (
        <text
          x={0}
          y={22}
          fontSize={18}
          fontWeight={600}
          fill="#111827"
        >
          {title}
        </text>
      )}
      <g transform={`translate(${margin.left},${margin.top})`}>
        {/* horizontal grid + y-axis labels */}
        {yTicks.map((t) => (
          <g key={t} transform={`translate(0,${y(t)})`}>
            <line x2={innerW} stroke="#e5e7eb" strokeDasharray="3 3" />
            {showYTicks && (
              <text x={-6} dy="0.32em" textAnchor="end" fontSize={fontSize} fill="#6b7280">
                {t.toLocaleString('en-AU')}
              </text>
            )}
          </g>
        ))}

        {/* stacked areas */}
        {stackedSeries.map((s) => (
          <path
            key={s.key}
            d={a(s as unknown as [number, number][]) ?? undefined}
            fill={COLOURS[s.key] ?? '#888'}
            fillOpacity={0.85}
          />
        ))}

        {/* x-axis ticks */}
        <g transform={`translate(0,${innerH})`}>
          <line x2={innerW} stroke="#9ca3af" />
          {showXTicks &&
            (compact ? [0, 6, 12, 18] : HOUR_TICKS).map((h) => {
              const cx = x(h * 12);
              const hour12 = ((h + 11) % 12) + 1;
              const ampm = h < 12 ? 'AM' : 'PM';
              return (
                <g key={h} transform={`translate(${cx},0)`}>
                  <line y2={4} stroke="#9ca3af" />
                  <text y={fontSize + 6} textAnchor="middle" fontSize={fontSize} fill="#6b7280">
                    {hour12}
                    <tspan fontSize={Math.round(fontSize * 0.6)}>{ampm}</tspan>
                  </text>
                </g>
              );
            })}
        </g>

        {/* y-axis unit label */}
        {showYTicks && !compact && (
          <text x={-margin.left + 4} y={-2} fontSize={11} fill="#6b7280">
            MW
          </text>
        )}
      </g>
      </svg>
    </div>
  );
}
