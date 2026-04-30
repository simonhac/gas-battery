// Generate public/data/completeness.json — % of expected 5-minute samples
// present in power_5m for each (region, fueltech, year). Expected per year =
// days_in_year × 288 (288 five-minute buckets per day).
//
// Years are bucketed in each region's market timezone (NEM regions →
// Australia/Brisbane, WEM → Australia/Perth) so the boundaries match the
// rest of the pipeline (see scripts/refresh-aggregates.ts).
//
// Run: pnpm completeness  (or chained from pnpm refresh).
import { sql } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/db';
import { INGEST_REGIONS, regionMeta, type Region } from '@/lib/regions';

const FUELTECHS = [
  'gas_ccgt',
  'gas_ocgt',
  'gas_recip',
  'gas_steam',
  'gas_wcmg',
  'battery_discharging',
  'hydro',
] as const;
type Fueltech = (typeof FUELTECHS)[number];

const TOD_BUCKETS = 288;

type Row = {
  region: Region;
  fueltech: Fueltech;
  byYear: Record<string, number>;
};

export async function generateCompleteness(): Promise<void> {
  const db = getDb();
  const t0 = Date.now();

  let minYear = Infinity;
  let maxYear = -Infinity;
  const byRegionTech = new Map<string, Map<number, number>>(); // key = `${region}|${fueltech}`

  for (const region of INGEST_REGIONS) {
    const tz = regionMeta(region).pgTimezone;
    const result = await db.execute(sql`
      SELECT fueltech,
             EXTRACT(YEAR FROM ts AT TIME ZONE ${tz})::int AS year,
             COUNT(*)::int AS n
        FROM power_5m
       WHERE region = ${region}
       GROUP BY 1, 2
    `);

    for (const r of result.rows as { fueltech: string; year: number; n: number }[]) {
      if (!FUELTECHS.includes(r.fueltech as Fueltech)) continue;
      if (r.year < minYear) minYear = r.year;
      if (r.year > maxYear) maxYear = r.year;
      const key = `${region}|${r.fueltech}`;
      let m = byRegionTech.get(key);
      if (!m) {
        m = new Map();
        byRegionTech.set(key, m);
      }
      m.set(r.year, r.n);
    }
  }

  if (!isFinite(minYear)) {
    throw new Error('No rows found in power_5m');
  }

  const rows: Row[] = [];
  for (const region of INGEST_REGIONS) {
    for (const fueltech of FUELTECHS) {
      const counts = byRegionTech.get(`${region}|${fueltech}`);
      const byYear: Record<string, number> = {};
      if (counts) {
        for (const [year, n] of counts) {
          const expected = expectedSamples(year);
          const ratio = n / expected;
          byYear[String(year)] = Math.round(Math.min(ratio, 1) * 10000) / 10000;
        }
      }
      rows.push({ region, fueltech, byYear });
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    minYear,
    maxYear,
    regions: INGEST_REGIONS,
    fueltechs: FUELTECHS,
    rows,
  };

  const outDir = join(process.cwd(), 'public', 'data');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'completeness.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(
    `generate-completeness: ${INGEST_REGIONS.length} regions × ${FUELTECHS.length} techs × ${maxYear - minYear + 1} years · ${Date.now() - t0}ms`,
  );
}

function expectedSamples(year: number): number {
  return daysInYear(year) * TOD_BUCKETS;
}

function daysInYear(year: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 366 : 365;
}

const isDirect = process.argv[1] && process.argv[1].endsWith('generate-completeness.ts');
if (isDirect) {
  generateCompleteness()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
