// Quick read-only health check across the data pipeline.
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';

async function main() {
  const db = getDb();

  console.log('\n=== power_5m (raw) ===');
  const counts = await db.execute(sql`
    SELECT region,
           COUNT(*)::int                                                           AS rows,
           COUNT(DISTINCT fueltech)::int                                          AS fueltechs,
           to_char(MIN(ts) AT TIME ZONE CASE WHEN region='WEM' THEN 'Australia/Perth' ELSE 'Australia/Brisbane' END, 'YYYY-MM-DD HH24:MI') AS first_ts,
           to_char(MAX(ts) AT TIME ZONE CASE WHEN region='WEM' THEN 'Australia/Perth' ELSE 'Australia/Brisbane' END, 'YYYY-MM-DD HH24:MI') AS last_ts,
           ROUND(MIN(power_mw)::numeric, 1)::float                                AS min_mw,
           ROUND(MAX(power_mw)::numeric, 1)::float                                AS max_mw
      FROM power_5m
     GROUP BY region
     ORDER BY region
  `);
  console.table(counts.rows);

  console.log('\n=== fueltechs per region ===');
  const ftech = await db.execute(sql`
    SELECT region, fueltech, COUNT(*)::int AS rows,
           to_char(MIN(ts), 'YYYY-MM-DD') AS first_day,
           to_char(MAX(ts), 'YYYY-MM-DD') AS last_day
      FROM power_5m
     GROUP BY region, fueltech
     ORDER BY region, fueltech
  `);
  console.table(ftech.rows);

  console.log('\n=== ingest_state ===');
  const ing = await db.execute(sql`
    SELECT region,
           to_char(last_completed_ts, 'YYYY-MM-DD HH24:MI TZ') AS last_completed_ts,
           to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
      FROM ingest_state
     ORDER BY region
  `);
  console.table(ing.rows);

  console.log('\n=== materialized view row counts ===');
  const mvs = await db.execute(sql`
    SELECT 'tod_weekly' AS view, COUNT(*)::int AS rows FROM tod_weekly
    UNION ALL
    SELECT 'tod_daily', COUNT(*)::int FROM tod_daily
    UNION ALL
    SELECT 'tod_daily_grouped', COUNT(*)::int FROM tod_daily_grouped
  `);
  console.table(mvs.rows);

  console.log('\n=== tod_daily_grouped per region/kind ===');
  const grouped = await db.execute(sql`
    SELECT region, kind, COUNT(*)::int AS rows,
           to_char(MIN(day_anchor), 'YYYY-MM-DD') AS first_day,
           to_char(MAX(day_anchor), 'YYYY-MM-DD') AS last_day,
           ROUND(MIN(mw)::numeric, 1)::float AS min_mw,
           ROUND(MAX(mw)::numeric, 1)::float AS max_mw
      FROM tod_daily_grouped
     GROUP BY region, kind
     ORDER BY region, kind
  `);
  console.table(grouped.rows);

  console.log('\n=== sample-count distribution per fueltech bucket (tod_daily) ===');
  const sc = await db.execute(sql`
    SELECT fueltech,
           COUNT(*)::int               AS buckets,
           MIN(sample_count)::int      AS min_sc,
           ROUND(AVG(sample_count)::numeric, 1)::float AS avg_sc,
           MAX(sample_count)::int      AS max_sc
      FROM tod_daily
     GROUP BY fueltech
     ORDER BY fueltech
  `);
  console.table(sc.rows);

  console.log('\n=== sanity: rows where power_mw is negative (excluding battery) ===');
  const neg = await db.execute(sql`
    SELECT region, fueltech, COUNT(*)::int AS rows
      FROM power_5m
     WHERE power_mw < -0.5
       AND fueltech <> 'battery_discharging'
     GROUP BY region, fueltech
     ORDER BY rows DESC
     LIMIT 20
  `);
  console.table(neg.rows);

  console.log('\n=== sanity: rows where power_mw is NULL or NaN ===');
  const bad = await db.execute(sql`
    SELECT COUNT(*)::int AS bad
      FROM power_5m
     WHERE power_mw IS NULL OR power_mw <> power_mw
  `);
  console.table(bad.rows);

  console.log('\n=== completeness summary (worst 10 cells, excluding 0% / no-data) ===');
  // Recompute completeness on the fly per (region,fueltech,year) and surface lowest non-zero.
  const cw = await db.execute(sql`
    WITH counts AS (
      SELECT region, fueltech,
             EXTRACT(YEAR FROM ts AT TIME ZONE CASE WHEN region='WEM' THEN 'Australia/Perth' ELSE 'Australia/Brisbane' END)::int AS year,
             COUNT(*)::int AS n
        FROM power_5m
       GROUP BY 1,2,3
    ),
    yrs AS (
      SELECT region, fueltech, year, n,
             CASE
               WHEN year % 400 = 0 THEN 366
               WHEN year % 100 = 0 THEN 365
               WHEN year % 4 = 0   THEN 366
               ELSE 365
             END * 288 AS expected
        FROM counts
    )
    SELECT region, fueltech, year, n, expected,
           ROUND((n::numeric / expected) * 100, 2) AS pct
      FROM yrs
     WHERE n::float / expected < 0.95
       AND n::float / expected > 0
     ORDER BY pct ASC
     LIMIT 15
  `);
  console.table(cw.rows);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
