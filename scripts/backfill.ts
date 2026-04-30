// One-off backfill: fetch power_5m for [2010-01-01, 2017-12-01) per region.
//
// Designed to run safely in parallel with `pnpm ingest`:
//   - Writes only `power_5m` rows; UPSERT on (ts, region, fueltech).
//   - Date range is strictly disjoint from what `ingest` is currently filling
//     (2017-12-01 onwards), so the two processes can't collide on a row.
//   - Never reads or writes `ingest_state` — cursors stay untouched.
//   - Does NOT refresh materialized views; run `pnpm refresh` once both
//     processes have exited to rebuild matviews + static binaries.
//
// Run: pnpm tsx --env-file=.env.local scripts/backfill.ts [--concurrency=N]
import { OpenElectricityClient } from 'openelectricity';
import type { UnitFueltechType } from 'openelectricity';
import pLimit from 'p-limit';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { iterateWindows, toNaiveLocal } from '@/lib/oe/paginate';
import { fetchWindow } from '@/lib/oe/fetcher';
import { INGEST_REGIONS, regionMeta, type Region } from '@/lib/regions';

const BACKFILL_FROM = new Date('2010-01-01T00:00:00Z');
const BACKFILL_TO = new Date('2017-12-01T00:00:00Z');

const FUELTECHS: UnitFueltechType[] = [
  'gas_ccgt',
  'gas_ocgt',
  'gas_recip',
  'gas_steam',
  'gas_wcmg',
  'battery_discharging',
  'hydro',
];
const PER_CALL_DELAY_MS = 200;
const FIVE_MIN_MS = 5 * 60_000;
const THIRTY_MIN_LO = 25 * 60_000;
const THIRTY_MIN_HI = 35 * 60_000;
const INSERT_CHUNK = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Sample = [tsMs: number, mw: number];

// Mirror of expandSamples in scripts/ingest.ts. Auto-detects 30m vs 5m source
// cadence per sample and fans 30m → 6 × 5m linearly-interpolated rows.
function* expandSamples(samples: Sample[]): Generator<Sample> {
  for (let i = 0; i < samples.length; i++) {
    const [tsA, valA] = samples[i];
    const next = samples[i + 1];
    const prev = i > 0 ? samples[i - 1] : null;
    const forwardGap = next ? next[0] - tsA : Number.POSITIVE_INFINITY;
    const backwardGap = prev ? tsA - prev[0] : Number.POSITIVE_INFINITY;
    const localGap = Math.min(forwardGap, backwardGap);
    const isThirtyMin = localGap >= THIRTY_MIN_LO && localGap <= THIRTY_MIN_HI;
    if (isThirtyMin) {
      const valB = next ? next[1] : valA;
      const slots = next
        ? Math.max(1, Math.min(6, Math.floor(forwardGap / FIVE_MIN_MS)))
        : 6;
      for (let k = 0; k < slots; k++) {
        yield [tsA + k * FIVE_MIN_MS, valA + (valB - valA) * (k / slots)];
      }
    } else {
      yield [tsA, valA];
    }
  }
}

async function flushRows(rows: schema.Power5mRow[]) {
  if (rows.length === 0) return;
  const db = getDb();
  await db
    .insert(schema.power5m)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.power5m.ts, schema.power5m.region, schema.power5m.fueltech],
      set: { powerMw: sql`excluded.power_mw` },
    });
}

async function backfillRegion(client: OpenElectricityClient, region: Region) {
  const meta = regionMeta(region);
  console.log(
    `[${region}] backfill ${toNaiveLocal(BACKFILL_FROM, meta.tzOffsetHours)} → ${toNaiveLocal(BACKFILL_TO, meta.tzOffsetHours)} (${meta.network}, UTC+${meta.tzOffsetHours})`,
  );

  // Phase 1: fetch all windows, accumulating raw samples per fueltech.
  const samplesByFt = new Map<string, Sample[]>();
  let windowCount = 0;
  for (const w of iterateWindows(BACKFILL_FROM, BACKFILL_TO)) {
    const t0 = Date.now();
    const rows = await fetchWindow(client, {
      network: meta.network,
      tzOffsetHours: meta.tzOffsetHours,
      region,
      fueltechs: FUELTECHS,
      ...w,
    });
    for (const r of rows) {
      let arr = samplesByFt.get(r.fueltech);
      if (!arr) {
        arr = [];
        samplesByFt.set(r.fueltech, arr);
      }
      arr.push([r.ts.getTime(), r.powerMw]);
    }
    windowCount += 1;
    console.log(
      `  [${region}] ${toNaiveLocal(w.dateStart, meta.tzOffsetHours)} → ${toNaiveLocal(w.dateEnd, meta.tzOffsetHours)}  rows=${rows.length}  ${Date.now() - t0}ms`,
    );
    await sleep(PER_CALL_DELAY_MS);
  }

  // Phase 2: per fueltech, sort + dedup, expand 30m → 5m, upsert in chunks.
  let totalRows = 0;
  for (const [ft, raw] of samplesByFt) {
    raw.sort((a, b) => a[0] - b[0]);
    const samples: Sample[] = [];
    for (const s of raw) {
      if (samples.length > 0 && samples[samples.length - 1][0] === s[0]) continue;
      samples.push(s);
    }

    let buffer: schema.Power5mRow[] = [];
    let count = 0;
    for (const [tsMs, mw] of expandSamples(samples)) {
      buffer.push({ ts: new Date(tsMs), region, fueltech: ft, powerMw: mw });
      if (buffer.length >= INSERT_CHUNK) {
        await flushRows(buffer);
        count += buffer.length;
        buffer = [];
      }
    }
    if (buffer.length > 0) {
      await flushRows(buffer);
      count += buffer.length;
    }
    totalRows += count;
    console.log(`  [${region}] ${ft}: ${samples.length} src → ${count} rows`);
  }

  return { rows: totalRows, windows: windowCount };
}

async function main() {
  const concurrency = (() => {
    const arg = process.argv.find((a) => a.startsWith('--concurrency='));
    const n = arg ? Number(arg.split('=')[1]) : 2;
    if (!Number.isFinite(n) || n < 1) throw new Error(`bad --concurrency value: ${arg}`);
    return n;
  })();

  const client = new OpenElectricityClient();
  console.log(
    `backfill ${BACKFILL_FROM.toISOString().slice(0, 10)} → ${BACKFILL_TO.toISOString().slice(0, 10)} · regions=${INGEST_REGIONS.length} · concurrency=${concurrency}`,
  );

  const limit = pLimit(concurrency);
  const t0 = Date.now();
  const results = await Promise.all(
    INGEST_REGIONS.map((r) => limit(() => backfillRegion(client, r))),
  );

  const totalRows = results.reduce((s, r) => s + r.rows, 0);
  const totalWindows = results.reduce((s, r) => s + r.windows, 0);
  console.log(
    `\nbackfill done: ${totalRows} rows across ${totalWindows} windows in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.log(
    'Next: when both this script and the in-flight `pnpm ingest` have exited, edit ALL_START in src/lib/regions.ts to 2010-01-01 and run `pnpm refresh`.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
