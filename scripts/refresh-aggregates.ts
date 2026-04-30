// Create (if needed) and refresh tod_weekly + tod_daily, then regenerate static files.
// Run: pnpm refresh
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { generateStatic } from './generate-static';
import { generateCompleteness } from './generate-completeness';

async function main() {
  const db = getDb();
  const t0 = Date.now();

  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS tod_monthly`);
  // Drop and recreate so per-region timezone (NEM=AEST, WEM=AWST) picks up.
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS tod_daily_grouped`);
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS tod_daily`);
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS tod_weekly`);

  // Anchor each region's day/week in its own market timezone:
  //   NEM regions (NSW1/QLD1/SA1/TAS1/VIC1) → Australia/Brisbane (AEST, UTC+10)
  //   WEM                                   → Australia/Perth   (AWST, UTC+8)
  // For NEM rows the CASE evaluates to Australia/Brisbane — same as before.
  await db.execute(sql`
    CREATE MATERIALIZED VIEW tod_weekly AS
    SELECT region,
           fueltech,
           date_trunc(
             'week',
             ts AT TIME ZONE CASE WHEN region = 'WEM' THEN 'Australia/Perth' ELSE 'Australia/Brisbane' END
           )::date AS week_anchor,
           ((EXTRACT(EPOCH FROM ts AT TIME ZONE CASE WHEN region = 'WEM' THEN 'Australia/Perth' ELSE 'Australia/Brisbane' END)::int % 86400) / 300)::int AS tod_bucket,
           AVG(power_mw)::float8 AS avg_mw,
           COUNT(*)              AS sample_count
      FROM power_5m
     GROUP BY 1, 2, 3, 4
    WITH NO DATA;
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS tod_weekly_pk
      ON tod_weekly (region, fueltech, week_anchor, tod_bucket);
  `);

  await db.execute(sql`
    CREATE MATERIALIZED VIEW tod_daily AS
    SELECT region,
           fueltech,
           (ts AT TIME ZONE CASE WHEN region = 'WEM' THEN 'Australia/Perth' ELSE 'Australia/Brisbane' END)::date AS day_anchor,
           ((EXTRACT(EPOCH FROM ts AT TIME ZONE CASE WHEN region = 'WEM' THEN 'Australia/Perth' ELSE 'Australia/Brisbane' END)::int % 86400) / 300)::int AS tod_bucket,
           AVG(power_mw)::float8 AS avg_mw,
           COUNT(*)              AS sample_count
      FROM power_5m
     GROUP BY 1, 2, 3, 4
    WITH NO DATA;
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS tod_daily_pk
      ON tod_daily (region, fueltech, day_anchor, tod_bucket);
  `);

  // Kinds:
  //   mid_merit = gas_ccgt + gas_steam + gas_wcmg  (base/intermediate gas)
  //   peakers   = gas_ocgt + gas_recip            (peaking gas)
  //   battery   = battery_discharging
  //   hydro     = hydro
  // The synthetic 'NEM' aggregate sums the 5 NEM regions only — WEM is a
  // separate market with its own timezone and is excluded from this rollup.
  await db.execute(sql`
    CREATE MATERIALIZED VIEW IF NOT EXISTS tod_daily_grouped AS
    SELECT region, 'mid_merit'::text AS kind, day_anchor, tod_bucket, SUM(avg_mw)::float8 AS mw
      FROM tod_daily WHERE fueltech IN ('gas_ccgt','gas_steam','gas_wcmg') GROUP BY 1, 2, 3, 4
    UNION ALL
    SELECT region, 'peakers'::text AS kind, day_anchor, tod_bucket, SUM(avg_mw)::float8 AS mw
      FROM tod_daily WHERE fueltech IN ('gas_ocgt','gas_recip') GROUP BY 1, 2, 3, 4
    UNION ALL
    SELECT region, 'battery'::text AS kind, day_anchor, tod_bucket, avg_mw AS mw
      FROM tod_daily WHERE fueltech = 'battery_discharging'
    UNION ALL
    SELECT region, 'hydro'::text AS kind, day_anchor, tod_bucket, avg_mw AS mw
      FROM tod_daily WHERE fueltech = 'hydro'
    UNION ALL
    SELECT 'NEM'::text AS region, 'mid_merit'::text AS kind, day_anchor, tod_bucket, SUM(avg_mw)::float8 AS mw
      FROM tod_daily
     WHERE fueltech IN ('gas_ccgt','gas_steam','gas_wcmg')
       AND region IN ('NSW1','QLD1','SA1','TAS1','VIC1')
     GROUP BY 3, 4
    UNION ALL
    SELECT 'NEM'::text AS region, 'peakers'::text AS kind, day_anchor, tod_bucket, SUM(avg_mw)::float8 AS mw
      FROM tod_daily
     WHERE fueltech IN ('gas_ocgt','gas_recip')
       AND region IN ('NSW1','QLD1','SA1','TAS1','VIC1')
     GROUP BY 3, 4
    UNION ALL
    SELECT 'NEM'::text AS region, 'battery'::text AS kind, day_anchor, tod_bucket, SUM(avg_mw)::float8 AS mw
      FROM tod_daily
     WHERE fueltech = 'battery_discharging'
       AND region IN ('NSW1','QLD1','SA1','TAS1','VIC1')
     GROUP BY 3, 4
    UNION ALL
    SELECT 'NEM'::text AS region, 'hydro'::text AS kind, day_anchor, tod_bucket, SUM(avg_mw)::float8 AS mw
      FROM tod_daily
     WHERE fueltech = 'hydro'
       AND region IN ('NSW1','QLD1','SA1','TAS1','VIC1')
     GROUP BY 3, 4
    WITH NO DATA;
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS tod_daily_grouped_pk
      ON tod_daily_grouped (region, kind, day_anchor, tod_bucket);
  `);

  console.log('refreshing tod_weekly...');
  await db.execute(sql`REFRESH MATERIALIZED VIEW tod_weekly`);
  console.log('refreshing tod_daily...');
  await db.execute(sql`REFRESH MATERIALIZED VIEW tod_daily`);
  console.log('refreshing tod_daily_grouped...');
  await db.execute(sql`REFRESH MATERIALIZED VIEW tod_daily_grouped`);

  const [{ weekly_count }] = (await db.execute(sql`SELECT count(*)::int AS weekly_count FROM tod_weekly`))
    .rows as { weekly_count: number }[];
  const [{ daily_count }] = (await db.execute(sql`SELECT count(*)::int AS daily_count FROM tod_daily`))
    .rows as { daily_count: number }[];
  const [{ grouped_count }] = (await db.execute(sql`SELECT count(*)::int AS grouped_count FROM tod_daily_grouped`))
    .rows as { grouped_count: number }[];
  console.log(`tod_weekly: ${weekly_count} · tod_daily: ${daily_count} · tod_daily_grouped: ${grouped_count} · ${Date.now() - t0}ms total`);

  console.log('generating static binaries...');
  await generateStatic();

  console.log('generating completeness data...');
  await generateCompleteness();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
