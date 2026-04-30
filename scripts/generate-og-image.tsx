// Generate the Open Graph preview image as a static PNG file:
//   public/og-image.png   — 1200×630, served by GitHub Pages with Content-Type: image/png.
//
// Why a build-time script instead of src/app/opengraph-image.tsx?
//   The Next.js route convention emits the file as `out/opengraph-image` (no extension).
//   GitHub Pages then serves it as application/octet-stream, and link previewers
//   (iMessage, Twitter, Facebook) refuse to render it. A real .png in public/ is
//   served correctly because GH Pages picks the MIME type from the extension.
//
// Run: pnpm generate:og  (also chained into deploy:pages before `next build`).

import { ImageResponse } from 'next/og';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const COLORS = ['#9a3412', '#f97316', '#4f46e5'];

type Manifest = {
  numDays: number;
  numBuckets: number;
  endDate: string;
  files: Record<string, string>;
};

async function main() {
  const dataDir = join(process.cwd(), 'public', 'data');
  const manifest = JSON.parse(
    await readFile(join(dataDir, 'manifest.json'), 'utf-8'),
  ) as Manifest;
  const buf = await readFile(join(dataDir, manifest.files.NEM));
  const arr = new Int16Array(
    buf.buffer,
    buf.byteOffset,
    Math.floor(buf.byteLength / 2),
  );

  const { numDays, numBuckets } = manifest;
  const seriesLen = numDays * numBuckets;

  const windowDays = 365;
  const endIdx = numDays - 1;
  const startIdx = Math.max(0, endIdx - (windowDays - 1));
  const n = endIdx - startIdx + 1;

  const series: number[][] = [];
  for (let s = 0; s < 3; s++) {
    const buckets = new Array<number>(numBuckets).fill(0);
    for (let d = startIdx; d <= endIdx; d++) {
      const off = s * seriesLen + d * numBuckets;
      for (let b = 0; b < numBuckets; b++) buckets[b] += arr[off + b];
    }
    for (let b = 0; b < numBuckets; b++) buckets[b] /= n;
    series.push(buckets);
  }

  const totals = series.map((s) => s.reduce((a, b) => a + b, 0));
  const grand = totals.reduce((a, b) => a + b, 0) || 1;
  const pcts = totals.map((t) => Math.round((t / grand) * 100));

  const [yy, mm, dd] = manifest.endDate.split('-').map(Number);
  const endDateNice = `${dd} ${MONTHS[mm - 1]} ${yy}`;

  // Chart geometry inside a 1120 × 380 box.
  const W = 1120;
  const H = 380;
  const PAD_L = 110;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 56;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  let yMaxRaw = 0;
  for (let b = 0; b < numBuckets; b++) {
    let stack = 0;
    for (const s of series) stack += s[b];
    if (stack > yMaxRaw) yMaxRaw = stack;
  }
  const STEP = 1000;
  const yMax = Math.max(STEP, Math.ceil(yMaxRaw / STEP) * STEP);

  const xScale = (b: number) => PAD_L + (b / (numBuckets - 1)) * innerW;
  const yScale = (v: number) => PAD_T + innerH - (v / yMax) * innerH;

  const cumulative = new Array<number>(numBuckets).fill(0);
  const paths: string[] = [];
  for (let s = 0; s < series.length; s++) {
    const top = series[s].map((v, b) => cumulative[b] + v);
    const bottom = [...cumulative];
    let d = `M ${xScale(0).toFixed(1)} ${yScale(top[0]).toFixed(1)}`;
    for (let b = 1; b < numBuckets; b++) d += ` L ${xScale(b).toFixed(1)} ${yScale(top[b]).toFixed(1)}`;
    for (let b = numBuckets - 1; b >= 0; b--) d += ` L ${xScale(b).toFixed(1)} ${yScale(bottom[b]).toFixed(1)}`;
    d += ' Z';
    paths.push(d);
    for (let b = 0; b < numBuckets; b++) cumulative[b] = top[b];
  }

  const yTicks: number[] = [];
  for (let v = 0; v <= yMax; v += STEP) yTicks.push(v);
  const xTicks = [
    { hour: 0, label: '12 AM' },
    { hour: 6, label: '6 AM' },
    { hour: 12, label: '12 PM' },
    { hour: 18, label: '6 PM' },
  ];

  const response = new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: 'white',
          padding: '40px 40px 28px 40px',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: '"Noto Sans"',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 60, fontWeight: 700, color: '#0f172a', letterSpacing: -1 }}>
            {`12 months to ${endDateNice}`}
          </div>
          <div style={{ fontSize: 34, color: '#52525b', marginTop: 6 }}>
            {`mid-merit ${pcts[0]}%, peaking ${pcts[1]}%, battery ${pcts[2]}%`}
          </div>
        </div>

        <div style={{ position: 'relative', display: 'flex', width: W, height: H, marginTop: 18 }}>
          <svg width={W} height={H} style={{ position: 'absolute', top: 0, left: 0 }}>
            {yTicks.map((t) => (
              <line
                key={t}
                x1={PAD_L}
                y1={yScale(t)}
                x2={W - PAD_R}
                y2={yScale(t)}
                stroke="#e5e7eb"
                strokeDasharray="4 4"
              />
            ))}
            {paths.map((d, i) => (
              <path key={i} d={d} fill={COLORS[i]} />
            ))}
            <line
              x1={PAD_L}
              y1={H - PAD_B}
              x2={W - PAD_R}
              y2={H - PAD_B}
              stroke="#9ca3af"
            />
          </svg>
          {yTicks.map((t) => (
            <div
              key={t}
              style={{
                position: 'absolute',
                top: yScale(t) - 14,
                left: 0,
                width: PAD_L - 14,
                fontSize: 22,
                color: '#6b7280',
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              {t.toLocaleString('en-AU')}
            </div>
          ))}
          {xTicks.map((t) => (
            <div
              key={t.hour}
              style={{
                position: 'absolute',
                left: xScale(t.hour * 12) - 50,
                top: H - PAD_B + 8,
                width: 100,
                fontSize: 22,
                color: '#6b7280',
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              {t.label}
            </div>
          ))}
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: PAD_T - 30,
              width: PAD_L - 14,
              fontSize: 18,
              color: '#9ca3af',
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            MW
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 28,
            fontSize: 24,
            color: '#52525b',
            marginTop: 'auto',
            alignItems: 'center',
          }}
        >
          <Legend color={COLORS[0]} label="mid-merit gas" />
          <Legend color={COLORS[1]} label="peaking gas" />
          <Legend color={COLORS[2]} label="battery discharging" />
          <div style={{ marginLeft: 'auto', display: 'flex', color: '#71717a' }}>
            simonhac.github.io/gas-battery
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );

  const out = Buffer.from(await response.arrayBuffer());
  const outPath = join(process.cwd(), 'public', 'og-image.png');
  await writeFile(outPath, out);
  console.log(`generate-og-image: wrote ${outPath} (${out.length} bytes)`);
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 22, height: 22, background: color, borderRadius: 3 }} />
      <div>{label}</div>
    </div>
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
