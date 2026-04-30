// Backfill / catchup OE 5m power data for gas + battery_discharging.
// Run: pnpm ingest          (= backfill from each region's cursor to ~now)
//      pnpm ingest --reset  (wipe ingest_state and start over from each region's start-of-time)
// Idempotent: safe to run on a cron — restarts from each region's last cursor.
//
// Two-phase per region:
//   1. Fetch all 8-day windows (API max), accumulate raw samples per fueltech.
//   2. Per fueltech: sort, dedup, detect cadence (5m vs 30m), linearly
//      interpolate 30m → 5m across the entire collected timeline (so there
//      are no gaps at window boundaries), then upsert in chunks.
import { OpenElectricityClient } from 'openelectricity';
import type { UnitFueltechType } from 'openelectricity';
import pLimit from 'p-limit';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { iterateWindows, lastCompleteBoundary, toNaiveLocal } from '@/lib/oe/paginate';
import { fetchWindow } from '@/lib/oe/fetcher';
import { INGEST_REGIONS, regionMeta, type Region } from '@/lib/regions';
import { refreshAggregates } from './refresh-aggregates';

// Fine-grained gas + battery_discharging + hydro. The 5 gas codes are summed
// at query time; hydro is a single fueltech in OE.
const FUELTECHS: UnitFueltechType[] = [
  'gas_ccgt',
  'gas_ocgt',
  'gas_recip',
  'gas_steam',
  'gas_wcmg',
  'battery_discharging',
  'hydro',
];
const REGION_CONCURRENCY = 2;
const PER_CALL_DELAY_MS = 200;
const FIVE_MIN_MS = 5 * 60_000;
// Treat any consecutive-sample gap inside this band as a 30-minute interval
// that should be expanded to 6 × 5-minute rows. Wider than ±5min so noisy
// timestamps still classify cleanly.
const THIRTY_MIN_LO = 25 * 60_000;
const THIRTY_MIN_HI = 35 * 60_000;
const INSERT_CHUNK = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Sample = [tsMs: number, mw: number];

async function getCursor(region: Region): Promise<Date> {
  const db = getDb();
  const [row] = await db
    .select({ lastCompletedTs: schema.ingestState.lastCompletedTs })
    .from(schema.ingestState)
    .where(sql`${schema.ingestState.region} = ${region}`)
    .limit(1);
  return row?.lastCompletedTs ?? regionMeta(region).startOfTime;
}

async function setCursor(region: Region, ts: Date) {
  const db = getDb();
  await db
    .insert(schema.ingestState)
    .values({ region, lastCompletedTs: ts })
    .onConflictDoUpdate({
      target: schema.ingestState.region,
      set: { lastCompletedTs: ts, updatedAt: sql`now()` },
    });
}

/**
 * Expand a sample timeline to 5-minute resolution. Each sample's local cadence
 * is decided by the smaller of its forward and backward neighbour gaps:
 * roughly-30min ⇒ the sample represents a 30-minute interval and is fanned
 * out to up to 6 × 5-minute rows with linear interpolation toward the next
 * sample's value; anything else is emitted as-is.
 *
 * The fan-out emits exactly `floor(forwardGap / 5min)` rows so the last row
 * lands strictly *before* the next sample's timestamp — preventing collisions
 * when the gap is at the lower edge of the 30m band (e.g. exactly 25min would
 * otherwise produce a row at tsA+25min that duplicates the next sample).
 *
 * Cross-cadence transition (WEM 30m→5m on 2023-10-01) works automatically:
 * the last 30m sample at 23:30 sees a 30min gap forward to the first 5m
 * sample at 00:00 and interpolates 23:30..23:55, then 00:00 (with both
 * neighbours 5min away) emits as-is once.
 */
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
      // Stay strictly inside the gap: floor(forwardGap/5min) slots, capped at 6.
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

async function ingestRegion(client: OpenElectricityClient, region: Region, target: Date) {
  const meta = regionMeta(region);
  const cursor = await getCursor(region);
  if (cursor >= target) {
    console.log(`[${region}] already up to ${toNaiveLocal(target, meta.tzOffsetHours)}`);
    return { rows: 0, windows: 0 };
  }
  console.log(
    `[${region}] ${toNaiveLocal(cursor, meta.tzOffsetHours)} → ${toNaiveLocal(target, meta.tzOffsetHours)} (${meta.network}, UTC+${meta.tzOffsetHours})`,
  );

  // Phase 1: fetch all windows, accumulating raw samples per fueltech.
  const samplesByFt = new Map<string, Sample[]>();
  let windowCount = 0;
  for (const w of iterateWindows(cursor, target)) {
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

  // Phase 2: per fueltech, sort + dedup, expand 30m → 5m where applicable,
  // upsert in chunks.
  let totalRows = 0;
  for (const [ft, raw] of samplesByFt) {
    raw.sort((a, b) => a[0] - b[0]);
    // Dedup: overlapping API windows can return the same timestamp twice.
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

  // Cursor advances once after all data is committed for this region.
  await setCursor(region, target);
  return { rows: totalRows, windows: windowCount };
}

async function main() {
  const reset = process.argv.includes('--reset');
  if (reset) {
    console.log('--reset: clearing ingest_state');
    await getDb().delete(schema.ingestState);
  }

  const client = new OpenElectricityClient();
  const target = lastCompleteBoundary(new Date());
  console.log(`target = ${target.toISOString()} UTC`);

  const limit = pLimit(REGION_CONCURRENCY);
  const t0 = Date.now();
  const results = await Promise.all(
    INGEST_REGIONS.map((r) => limit(() => ingestRegion(client, r, target))),
  );

  const totalRows = results.reduce((s, r) => s + r.rows, 0);
  const totalWindows = results.reduce((s, r) => s + r.windows, 0);
  console.log(`\ndone: ${totalRows} rows across ${totalWindows} windows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (totalRows > 0) {
    console.log('refreshing aggregates...');
    await refreshAggregates();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
