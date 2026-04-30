import {
  date,
  doublePrecision,
  index,
  integer,
  pgMaterializedView,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const power5m = pgTable(
  'power_5m',
  {
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull(),
    region: text('region').notNull(),
    fueltech: text('fueltech').notNull(),
    powerMw: doublePrecision('power_mw').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ts, t.region, t.fueltech] }),
    index('power_5m_region_ftg_ts_idx').on(t.region, t.fueltech, t.ts),
  ],
);

export type Power5mRow = typeof power5m.$inferInsert;

export const ingestState = pgTable('ingest_state', {
  region: text('region').primaryKey(),
  lastCompletedTs: timestamp('last_completed_ts', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// Managed by scripts/refresh-aggregates.ts (Drizzle does not generate the DDL).
// week_anchor = Monday of the ISO week (in AEST), the lower bound of the 7-day bucket.
export const todWeekly = pgMaterializedView('tod_weekly', {
  region: text('region').notNull(),
  fueltech: text('fueltech').notNull(),
  weekAnchor: date('week_anchor', { mode: 'date' }).notNull(),
  todBucket: integer('tod_bucket').notNull(),
  avgMw: doublePrecision('avg_mw').notNull(),
  sampleCount: integer('sample_count').notNull(),
}).existing();

// day_anchor = the AEST calendar day. Used for daily-resolution rolling windows (e.g. 28d view).
export const todDaily = pgMaterializedView('tod_daily', {
  region: text('region').notNull(),
  fueltech: text('fueltech').notNull(),
  dayAnchor: date('day_anchor', { mode: 'date' }).notNull(),
  todBucket: integer('tod_bucket').notNull(),
  avgMw: doublePrecision('avg_mw').notNull(),
  sampleCount: integer('sample_count').notNull(),
}).existing();

// Pre-aggregated daily values keyed by region + "kind" (all_gas / peakers / battery).
// Region 'NEM' is included as the sum of all 5 NEM regions. Reads from this directly
// avoid the heavy GROUP BY in the timeline endpoint.
export const todDailyGrouped = pgMaterializedView('tod_daily_grouped', {
  region: text('region').notNull(),
  kind: text('kind').notNull(),
  dayAnchor: date('day_anchor', { mode: 'date' }).notNull(),
  todBucket: integer('tod_bucket').notNull(),
  mw: doublePrecision('mw').notNull(),
}).existing();
