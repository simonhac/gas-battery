// Generate static binary files for the time-of-day app:
//   public/data/tod-{REGION}-{YYYYMMDD}.bin   — Int16 MW values, layout below
//   public/data/manifest.json                  — current filenames + metadata
//
// One file per region; each contains all 3 tech series for the full timeline since
// the first day in tod_daily_grouped. The client downloads one file per region and
// computes any rolling window / date slice locally — no API roundtrips.
//
// Binary layout (Int16 little-endian, MW):
//   numSeries × numDays × 288 buckets, series-major.
//   Series order: mid_merit_gas, peaking_gas, battery_discharging, hydro.
//
// Run: pnpm refresh (chains this step at the end) or `tsx --env-file=.env.local scripts/generate-static.ts`.
import { sql } from 'drizzle-orm';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/db';
import { REGIONS } from '@/lib/regions';

const SERIES = ['mid_merit', 'peakers', 'battery', 'hydro'] as const; // matview kind values
const SERIES_NAMES = ['mid_merit_gas', 'peaking_gas', 'battery_discharging', 'hydro'] as const;
const TOD_BUCKETS = 288;

export async function generateStatic(): Promise<void> {
  const db = getDb();
  const t0 = Date.now();

  const range = await db.execute(sql`
    SELECT to_char(MIN(day_anchor), 'YYYY-MM-DD') AS s,
           to_char(MAX(day_anchor), 'YYYY-MM-DD') AS e
      FROM tod_daily_grouped
  `);
  const startDate = (range.rows[0] as { s: string }).s;
  const endDate = (range.rows[0] as { e: string }).e;
  const numDays = daysBetweenInclusive(startDate, endDate);

  const outDir = join(process.cwd(), 'public', 'data');
  mkdirSync(outDir, { recursive: true });

  // Clean any previously-generated tod-*.bin so the directory only ever holds the latest set.
  for (const name of readdirSync(outDir)) {
    if (/^tod-[A-Z0-9]+-\d{8}\.bin$/.test(name)) unlinkSync(join(outDir, name));
  }

  const stamp = formatStamp(new Date());
  const files: Record<string, string> = {};
  let totalBytes = 0;

  // Per-region queries run in parallel — they hit independent slices of the
  // (region-leading) PK and don't contend on the same pages.
  const perRegion = await Promise.all(
    REGIONS.map(async (region) => {
      const rows = await db.execute(sql`
        SELECT kind::text                  AS kind,
               (day_anchor - ${startDate}::date)::int AS d_idx,
               tod_bucket::int             AS bucket,
               ROUND(mw)::int              AS mw
          FROM tod_daily_grouped
         WHERE region = ${region}
      `);
      const buf = new Int16Array(SERIES.length * numDays * TOD_BUCKETS);
      for (const row of rows.rows as { kind: string; d_idx: number; bucket: number; mw: number }[]) {
        const sIdx = SERIES.indexOf(row.kind as (typeof SERIES)[number]);
        if (sIdx < 0) continue;
        const dIdx = row.d_idx;
        if (dIdx < 0 || dIdx >= numDays) continue;
        buf[sIdx * numDays * TOD_BUCKETS + dIdx * TOD_BUCKETS + row.bucket] = row.mw | 0;
      }
      return { region, buf };
    }),
  );
  for (const { region, buf } of perRegion) {
    const filename = `tod-${region}-${stamp}.bin`;
    writeFileSync(join(outDir, filename), Buffer.from(buf.buffer));
    files[region] = filename;
    const size = statSync(join(outDir, filename)).size;
    totalBytes += size;
    console.log(`  ${region}: ${filename} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    numDays,
    numBuckets: TOD_BUCKETS,
    seriesNames: SERIES_NAMES,
    dtype: 'int16' as const,
    unit: 'MW' as const,
    files,
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(
    `generate-static: ${REGIONS.length} regions × ${numDays} days × ${TOD_BUCKETS} buckets × ${SERIES.length} series · ${(totalBytes / 1024 / 1024).toFixed(1)} MB total · ${Date.now() - t0}ms`,
  );
}

function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function daysBetweenInclusive(aIso: string, bIso: string): number {
  return Math.round((parseDate(bIso).getTime() - parseDate(aIso).getTime()) / 86_400_000) + 1;
}

function formatStamp(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// CLI entry: only run when executed directly (skipped when imported by refresh-aggregates.ts).
const isDirect = process.argv[1] && process.argv[1].endsWith('generate-static.ts');
if (isDirect) {
  generateStatic()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
