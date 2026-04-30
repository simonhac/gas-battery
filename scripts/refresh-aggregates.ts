// Incremental refresh of tod_daily and tod_daily_grouped, then regenerate
// static files. Only the last REFRESH_WINDOW_DAYS days are re-aggregated each
// run; older days are preserved as-is.
//
// Flags:
//   --rebuild  drop the tables and re-aggregate the full history (slow).
//
// On first run after the matview→table migration, existing matview data is
// copied into the new tables (cheap row-copy), so the subsequent incremental
// refresh only touches the recent days.
//
// Run: pnpm refresh
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { generateStatic } from './generate-static';
import { generateCompleteness } from './generate-completeness';

// Days of recent past re-aggregated each run. Comfortably covers any
// late-arriving data plus the AEST/AWST timezone offset.
const REFRESH_WINDOW_DAYS = 14;

// Per-region market timezone (NEM regions = AEST, WEM = AWST). Anchors day
// boundaries and 5-minute bucket numbering.
const TZ_EXPR = sql`CASE WHEN region = 'WEM' THEN 'Australia/Perth' ELSE 'Australia/Brisbane' END`;

type Db = ReturnType<typeof getDb>;

type Probe = { kind: 'r' } | { kind: 'm'; populated: boolean } | null;

async function probe(db: Db, name: string): Promise<Probe> {
  const r = await db.execute(sql`
    SELECT relkind, relispopulated FROM pg_class WHERE relname = ${name}
  `);
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as { relkind: string; relispopulated: boolean };
  if (row.relkind === 'r') return { kind: 'r' };
  if (row.relkind === 'm') return { kind: 'm', populated: row.relispopulated };
  return null;
}

async function dropAny(db: Db, name: string): Promise<void> {
  const p = await probe(db, name);
  if (!p) return;
  if (p.kind === 'm') await db.execute(sql.raw(`DROP MATERIALIZED VIEW IF EXISTS ${name}`));
  else await db.execute(sql.raw(`DROP TABLE IF EXISTS ${name}`));
}

async function ensureSchema(db: Db, rebuild: boolean): Promise<void> {
  const td = await probe(db, 'tod_daily');
  const tg = await probe(db, 'tod_daily_grouped');

  if (rebuild) {
    await dropAny(db, 'tod_daily_grouped');
    await dropAny(db, 'tod_daily');
  } else {
    // If a previous schema's matview was populated, copy its rows into a new
    // table to skip the slow re-aggregation. Unpopulated matviews carry no
    // data, so they're just dropped (full bootstrap will follow).
    const migrateDaily = td?.kind === 'm' && td.populated;
    const migrateGrouped = tg?.kind === 'm' && tg.populated;
    if (migrateDaily || migrateGrouped) {
      console.log('migrating matviews → tables (preserving aggregates)…');
      // Clear any leftover *_new tables from a previous failed run.
      await db.execute(sql`DROP TABLE IF EXISTS tod_daily_new`);
      await db.execute(sql`DROP TABLE IF EXISTS tod_daily_grouped_new`);
      if (migrateDaily) {
        await db.execute(sql`CREATE TABLE tod_daily_new AS SELECT * FROM tod_daily`);
      }
      if (migrateGrouped) {
        await db.execute(sql`CREATE TABLE tod_daily_grouped_new AS SELECT * FROM tod_daily_grouped`);
      }
    }
    // Drop matviews (in dependency order: grouped first). Drops both
    // populated-and-copied and unpopulated cases.
    if (tg?.kind === 'm') await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS tod_daily_grouped`);
    if (td?.kind === 'm') await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS tod_daily`);
    if (migrateDaily) {
      await db.execute(sql`ALTER TABLE tod_daily_new RENAME TO tod_daily`);
      await db.execute(sql`ALTER TABLE tod_daily ADD PRIMARY KEY (region, fueltech, day_anchor, tod_bucket)`);
    }
    if (migrateGrouped) {
      await db.execute(sql`ALTER TABLE tod_daily_grouped_new RENAME TO tod_daily_grouped`);
      await db.execute(sql`ALTER TABLE tod_daily_grouped ADD PRIMARY KEY (region, kind, day_anchor, tod_bucket)`);
    }
  }

  // Drop the legacy tod_weekly matview unconditionally — no longer used.
  await dropAny(db, 'tod_weekly');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tod_daily (
      region        text    NOT NULL,
      fueltech      text    NOT NULL,
      day_anchor    date    NOT NULL,
      tod_bucket    integer NOT NULL,
      avg_mw        float8  NOT NULL,
      sample_count  integer NOT NULL,
      PRIMARY KEY (region, fueltech, day_anchor, tod_bucket)
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tod_daily_grouped (
      region      text    NOT NULL,
      kind        text    NOT NULL,
      day_anchor  date    NOT NULL,
      tod_bucket  integer NOT NULL,
      mw          float8  NOT NULL,
      PRIMARY KEY (region, kind, day_anchor, tod_bucket)
    )
  `);
  // day_anchor indexes power the incremental refresh's range filter (DELETE +
  // SELECT WHERE day_anchor >= since); without them the planner falls back on
  // a seq scan over tens of millions of rows.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS tod_daily_day_idx ON tod_daily (day_anchor)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS tod_daily_grouped_day_idx ON tod_daily_grouped (day_anchor)
  `);
}

async function refreshDaily(db: Db, sinceDate: string | null): Promise<void> {
  if (sinceDate) {
    await db.execute(sql`DELETE FROM tod_daily WHERE day_anchor >= ${sinceDate}::date`);
  }
  // Filter source rows by ts; subtract a day so AEST/AWST day boundaries near
  // the cutoff are fully covered. The day-before-cutoff overlap (already
  // present from a prior run) is handled by the upsert.
  const tsFilter = sinceDate
    ? sql`WHERE ts >= (${sinceDate}::date - INTERVAL '1 day')`
    : sql``;
  await db.execute(sql`
    INSERT INTO tod_daily (region, fueltech, day_anchor, tod_bucket, avg_mw, sample_count)
    SELECT region,
           fueltech,
           (ts AT TIME ZONE ${TZ_EXPR})::date AS day_anchor,
           ((EXTRACT(EPOCH FROM ts AT TIME ZONE ${TZ_EXPR})::int % 86400) / 300)::int AS tod_bucket,
           AVG(power_mw)::float8 AS avg_mw,
           COUNT(*)              AS sample_count
      FROM power_5m
      ${tsFilter}
     GROUP BY 1, 2, 3, 4
    ON CONFLICT (region, fueltech, day_anchor, tod_bucket)
    DO UPDATE SET avg_mw = EXCLUDED.avg_mw, sample_count = EXCLUDED.sample_count
  `);
}

async function refreshGrouped(db: Db, sinceDate: string | null): Promise<void> {
  if (sinceDate) {
    await db.execute(sql`DELETE FROM tod_daily_grouped WHERE day_anchor >= ${sinceDate}::date`);
  }
  // Aggregate from tod_daily; the synthetic 'NEM' rows sum the 5 NEM regions
  // (WEM excluded — different timezone, different market).
  const dayFilter = sinceDate ? sql`WHERE day_anchor >= ${sinceDate}::date` : sql``;
  await db.execute(sql`
    INSERT INTO tod_daily_grouped (region, kind, day_anchor, tod_bucket, mw)
    WITH src AS MATERIALIZED (SELECT * FROM tod_daily ${dayFilter})
    SELECT region, 'mid_merit'::text, day_anchor, tod_bucket, SUM(avg_mw)::float8
      FROM src WHERE fueltech IN ('gas_ccgt','gas_steam','gas_wcmg') GROUP BY 1, 2, 3, 4
    UNION ALL
    SELECT region, 'peakers'::text, day_anchor, tod_bucket, SUM(avg_mw)::float8
      FROM src WHERE fueltech IN ('gas_ocgt','gas_recip') GROUP BY 1, 2, 3, 4
    UNION ALL
    SELECT region, 'battery'::text, day_anchor, tod_bucket, avg_mw
      FROM src WHERE fueltech = 'battery_discharging'
    UNION ALL
    SELECT region, 'hydro'::text, day_anchor, tod_bucket, avg_mw
      FROM src WHERE fueltech = 'hydro'
    UNION ALL
    SELECT 'NEM'::text, 'mid_merit'::text, day_anchor, tod_bucket, SUM(avg_mw)::float8
      FROM src WHERE fueltech IN ('gas_ccgt','gas_steam','gas_wcmg')
       AND region IN ('NSW1','QLD1','SA1','TAS1','VIC1') GROUP BY 3, 4
    UNION ALL
    SELECT 'NEM'::text, 'peakers'::text, day_anchor, tod_bucket, SUM(avg_mw)::float8
      FROM src WHERE fueltech IN ('gas_ocgt','gas_recip')
       AND region IN ('NSW1','QLD1','SA1','TAS1','VIC1') GROUP BY 3, 4
    UNION ALL
    SELECT 'NEM'::text, 'battery'::text, day_anchor, tod_bucket, SUM(avg_mw)::float8
      FROM src WHERE fueltech = 'battery_discharging'
       AND region IN ('NSW1','QLD1','SA1','TAS1','VIC1') GROUP BY 3, 4
    UNION ALL
    SELECT 'NEM'::text, 'hydro'::text, day_anchor, tod_bucket, SUM(avg_mw)::float8
      FROM src WHERE fueltech = 'hydro'
       AND region IN ('NSW1','QLD1','SA1','TAS1','VIC1') GROUP BY 3, 4
  `);
}

/**
 * Compute the "incremental refresh starting day" for a table: MAX(day_anchor)
 * minus REFRESH_WINDOW_DAYS. Returns null when the table is empty (caller
 * should bootstrap from scratch).
 */
async function sinceDateFor(db: Db, table: 'tod_daily' | 'tod_daily_grouped'): Promise<string | null> {
  const tableSql = table === 'tod_daily' ? sql`tod_daily` : sql`tod_daily_grouped`;
  const r = await db.execute(sql`SELECT MAX(day_anchor)::text AS m FROM ${tableSql}`);
  const maxDay = (r.rows[0] as { m: string | null }).m;
  if (!maxDay) return null;
  const since = await db.execute(sql`
    SELECT (${maxDay}::date - ${REFRESH_WINDOW_DAYS} * INTERVAL '1 day')::date::text AS d
  `);
  return (since.rows[0] as { d: string }).d;
}

/** Refresh tod_daily + tod_daily_grouped only (no static-file regen). */
export async function refreshAggregates(opts: { rebuild?: boolean } = {}): Promise<void> {
  const db = getDb();
  const t0 = Date.now();

  await ensureSchema(db, opts.rebuild === true);

  // Each table refreshes from its own MAX(day_anchor); a null since-date
  // means the table is empty and we bootstrap it from scratch. This handles
  // the (uncommon) case where the two tables drift apart, e.g. when one
  // migration succeeded and the other had to be rebuilt.
  const dailySince = await sinceDateFor(db, 'tod_daily');
  const t1 = Date.now();
  console.log(
    dailySince
      ? `tod_daily: incremental from ${dailySince} (last ${REFRESH_WINDOW_DAYS} days)`
      : 'tod_daily: bootstrap from power_5m…',
  );
  await refreshDaily(db, dailySince);
  console.log(`  ${Date.now() - t1}ms`);

  const groupedSince = await sinceDateFor(db, 'tod_daily_grouped');
  const t2 = Date.now();
  console.log(
    groupedSince
      ? `tod_daily_grouped: incremental from ${groupedSince} (last ${REFRESH_WINDOW_DAYS} days)`
      : 'tod_daily_grouped: bootstrap from tod_daily…',
  );
  await refreshGrouped(db, groupedSince);
  console.log(`  ${Date.now() - t2}ms`);

  const [{ daily_count }] = (await db.execute(sql`SELECT count(*)::int AS daily_count FROM tod_daily`))
    .rows as { daily_count: number }[];
  const [{ grouped_count }] = (await db.execute(sql`SELECT count(*)::int AS grouped_count FROM tod_daily_grouped`))
    .rows as { grouped_count: number }[];
  console.log(`tod_daily: ${daily_count} · tod_daily_grouped: ${grouped_count} · ${Date.now() - t0}ms total`);
}

async function main() {
  const rebuild = process.argv.includes('--rebuild');
  await refreshAggregates({ rebuild });

  console.log('generating static binaries...');
  await generateStatic();

  console.log('generating completeness data...');
  await generateCompleteness();
}

const isDirect = process.argv[1] && process.argv[1].endsWith('refresh-aggregates.ts');
if (isDirect) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
