'use client';

import { area, scaleLinear, max as d3max } from 'd3';
import { useContainerWidth } from '@/lib/use-container-width';

const COLOURS = {
  mid_merit: '#9a3412', // orange-800
  peakers: '#f97316', // orange-500
  battery: '#4f46e5', // indigo
  hydro: '#0d9488', // teal-600
};

/**
 * Compact summary chart spanning the entire animation period.
 * X-axis: time (one slot per day from startDate). Y-axis: mean MW across the 24-hour profile
 * for the rolling window ending at that day. Stacked (bottom → top): mid-merit gas (optional)
 * + peaking gas + battery_discharging + hydro. A vertical line marks the current frame.
 *
 * The indicator pill shows battery share of (gas + battery), where "gas" is mid-merit + peakers
 * (or just peakers when mid-merit is disabled). Hydro is excluded from the share calculation
 * since the pill is a fast-response (battery vs gas) indicator.
 */
export function TodTimelineSummary({
  startDate,
  numDays,
  midMeritTotal,
  peakersTotal,
  batTotal,
  hydroTotal,
  minFrame,
  maxFrame,
  currentFrame,
  width = 1100,
  height = 240,
  title,
  onFrameChange,
}: {
  startDate: string; // 'YYYY-MM-DD' for index 0 of the input arrays
  numDays: number;
  /** Per-frame mean MW for each series. Pass null to omit that layer. */
  midMeritTotal: Float32Array | number[] | null;
  peakersTotal: Float32Array | number[] | null;
  batTotal: Float32Array | number[] | null;
  hydroTotal: Float32Array | number[] | null;
  /** First plotted frame index (typically the user's "From" date). */
  minFrame: number;
  /** Last plotted frame index (typically the user's "To" date). Defaults to numDays - 1 for back-compat. */
  maxFrame?: number;
  currentFrame: number;
  width?: number;
  height?: number;
  title?: string;
  onFrameChange?: (frame: number) => void;
}) {
  // `width` is the SSR/initial render fallback; once mounted the wrapper div's
  // measured CSS width takes over so the SVG renders at exact pixel size and
  // height stays fixed while width follows the page.
  const [measuredWidth, containerRef] = useContainerWidth(width);
  const lastFrame = maxFrame ?? numDays - 1;
  // Margins match TodChart so the two plot areas line up.
  const margin = { top: title ? 56 : 28, right: 24, bottom: 28, left: 64 };
  const innerW = measuredWidth - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const includeMidMerit = midMeritTotal !== null;
  const includePeakers = peakersTotal !== null;
  const includeBat = batTotal !== null;
  const includeHydro = hydroTotal !== null;
  const midGet = (f: number): number => (midMeritTotal ? midMeritTotal[f] ?? 0 : 0);
  const peakersGet = (f: number): number => (peakersTotal ? peakersTotal[f] ?? 0 : 0);
  const batGet = (f: number): number => (batTotal ? batTotal[f] ?? 0 : 0);
  const hydroGet = (f: number): number => (hydroTotal ? hydroTotal[f] ?? 0 : 0);

  const x = scaleLinear()
    .domain([minFrame, lastFrame])
    .range([0, innerW]);
  const yMaxRaw =
    d3max(Array.from({ length: lastFrame - minFrame + 1 }, (_, i) => {
      const f = i + minFrame;
      return midGet(f) + peakersGet(f) + batGet(f) + hydroGet(f);
    })) ?? 0;
  const y = scaleLinear().domain([0, yMaxRaw]).range([innerH, 0]).nice();

  // Build per-frame array of stacked layers with running cumulative sums.
  type Row = { frame: number; midTop: number; peakTop: number; batTop: number; hydroTop: number };
  const data: Row[] = [];
  for (let f = minFrame; f <= lastFrame; f++) {
    const m = midGet(f);
    const p = peakersGet(f);
    const b = batGet(f);
    const h = hydroGet(f);
    data.push({
      frame: f,
      midTop: m,
      peakTop: m + p,
      batTop: m + p + b,
      hydroTop: m + p + b + h,
    });
  }

  const midArea = area<Row>()
    .x((d) => x(d.frame))
    .y0(innerH)
    .y1((d) => y(d.midTop));
  const peakersArea = area<Row>()
    .x((d) => x(d.frame))
    .y0((d) => y(d.midTop))
    .y1((d) => y(d.peakTop));
  const batArea = area<Row>()
    .x((d) => x(d.frame))
    .y0((d) => y(d.peakTop))
    .y1((d) => y(d.batTop));
  const hydroArea = area<Row>()
    .x((d) => x(d.frame))
    .y0((d) => y(d.batTop))
    .y1((d) => y(d.hydroTop));

  // X-axis tick labels: yearly when span ≥ ~2 years, otherwise monthly.
  const start = parseDate(startDate);
  const endFrame = lastFrame;
  const endDate = addDays(start, endFrame);
  const spanDays = endFrame - minFrame + 1;
  const useMonths = spanDays < 730;
  const xTicks: { label: string; frame: number }[] = [];
  if (useMonths) {
    // Walk months starting from the first day of the visible window's first month,
    // not from the timeline's start (which can be many years before the visible range).
    const visibleStart = addDays(start, minFrame);
    const firstMonth = new Date(Date.UTC(visibleStart.getUTCFullYear(), visibleStart.getUTCMonth(), 1));
    for (let i = 0; i < 36; i++) {
      const t = new Date(Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() + i, 1));
      const frame = Math.round((t.getTime() - start.getTime()) / 86_400_000);
      if (frame > endFrame) break;
      if (frame < minFrame) continue;
      const m = t.getUTCMonth();
      const yr = t.getUTCFullYear();
      const label = m === 0 || xTicks.length === 0 ? `${MONTH_ABBR[m]} ${yr}` : MONTH_ABBR[m];
      xTicks.push({ label, frame });
    }
  } else {
    const startYear = start.getUTCFullYear();
    const endYear = endDate.getUTCFullYear();
    for (let yr = startYear; yr <= endYear; yr++) {
      const t = new Date(Date.UTC(yr, 0, 1));
      const frame = Math.round((t.getTime() - start.getTime()) / 86_400_000);
      if (frame >= minFrame && frame <= endFrame) xTicks.push({ label: String(yr), frame });
    }
  }

  const yTicks = y.ticks(4);

  function handleClickOrDrag(evt: React.MouseEvent<SVGSVGElement>) {
    if (!onFrameChange) return;
    const rect = (evt.currentTarget as SVGSVGElement).getBoundingClientRect();
    // SVG renders at measuredWidth CSS pixels (no viewBox scaling), so
    // rect.width ≈ measuredWidth and the ratio handles browser zoom uniformly.
    const px = evt.clientX - rect.left - (rect.width * margin.left) / measuredWidth;
    const innerPx = (rect.width * innerW) / measuredWidth;
    const frac = Math.max(0, Math.min(1, px / innerPx));
    const f = Math.round(minFrame + frac * (lastFrame - minFrame));
    onFrameChange(f);
  }

  return (
    <div ref={containerRef} className="w-full">
      <svg
        width={measuredWidth}
        height={height}
        className="font-sans block cursor-crosshair select-none"
        onMouseDown={handleClickOrDrag}
        onMouseMove={(e) => {
          if (e.buttons === 1) handleClickOrDrag(e);
        }}
      >
      {title && (
        <text x={0} y={22} fontSize={18} fontWeight={600} fill="#111827">
          {title}
        </text>
      )}
      <g transform={`translate(${margin.left},${margin.top})`}>
        {/* y-axis grid + labels */}
        {yTicks.map((t) => (
          <g key={t} transform={`translate(0,${y(t)})`}>
            <line x2={innerW} stroke="#e5e7eb" strokeDasharray="3 3" />
            <text x={-6} dy="0.32em" textAnchor="end" fontSize={12} fill="#6b7280">
              {t.toLocaleString('en-AU')}
            </text>
          </g>
        ))}

        {/* stacked areas (bottom → top) */}
        {includeMidMerit && (
          <path d={midArea(data) ?? undefined} fill={COLOURS.mid_merit} fillOpacity={0.85} />
        )}
        {includePeakers && (
          <path d={peakersArea(data) ?? undefined} fill={COLOURS.peakers} fillOpacity={0.85} />
        )}
        {includeBat && (
          <path d={batArea(data) ?? undefined} fill={COLOURS.battery} fillOpacity={0.85} />
        )}
        {includeHydro && (
          <path d={hydroArea(data) ?? undefined} fill={COLOURS.hydro} fillOpacity={0.85} />
        )}

        {/* current-frame indicator: line + rounded-square pill showing battery share of total gas */}
        {currentFrame >= minFrame && (() => {
          const m = midGet(currentFrame);
          const p = peakersGet(currentFrame);
          const b = batGet(currentFrame);
          const denom = m + p + b;
          const pct = denom > 0 ? (b / denom) * 100 : 0;
          const label = includeBat ? `${pct.toFixed(0)}%` : '';
          const labelW = 56;
          const labelH = 20;
          const padX = 6;
          const iconW = 12;
          const iconH = 8;
          const gap = 4;
          const cx = x(currentFrame);
          // Icon left edge inside the pill, then text fills the rest centred.
          const iconLeft = -labelW / 2 + padX;
          const textCx = (iconLeft + iconW + gap + (labelW / 2 - padX)) / 2;
          return (
            <g>
              <line
                x1={x(currentFrame)}
                x2={x(currentFrame)}
                y1={0}
                y2={innerH}
                stroke="#111827"
                strokeWidth={1.5}
              />
              <g transform={`translate(${cx},${-labelH / 2 - 2})`}>
                <rect
                  x={-labelW / 2}
                  y={-labelH / 2}
                  width={labelW}
                  height={labelH}
                  rx={4}
                  fill={COLOURS.battery}
                />
                {includeBat && (
                  <g transform={`translate(${iconLeft}, ${-iconH / 2})`} stroke="white" fill="none">
                    <rect
                      x={0.5}
                      y={0.5}
                      width={iconW - 1}
                      height={iconH - 1}
                      rx={1}
                      strokeWidth={1}
                    />
                    <rect
                      x={iconW}
                      y={iconH / 4}
                      width={1.5}
                      height={iconH / 2}
                      fill="white"
                      stroke="none"
                    />
                  </g>
                )}
                <text
                  x={textCx}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight={600}
                  fill="white"
                >
                  {label}
                </text>
              </g>
            </g>
          );
        })()}

        {/* x-axis baseline + tick labels */}
        <line y1={innerH} y2={innerH} x2={innerW} stroke="#9ca3af" />
        {xTicks.map((t) => (
          <g key={`${t.label}-${t.frame}`} transform={`translate(${x(t.frame)},${innerH})`}>
            <line y2={4} stroke="#9ca3af" />
            <text y={18} textAnchor="middle" fontSize={12} fill="#6b7280">
              {t.label}
            </text>
          </g>
        ))}

        {/* y-axis unit label */}
        <text x={-margin.left + 4} y={-2} fontSize={11} fill="#6b7280">
          MW
        </text>
      </g>
      </svg>
    </div>
  );
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}
