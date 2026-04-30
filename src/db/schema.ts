import {
  date,
  doublePrecision,
  index,
  integer,
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

// DDL managed by scripts/refresh-aggregates.ts (incremental upserts, not Drizzle).
// day_anchor = market-tz calendar day (NEM=AEST, WEM=AWST).
export const todDaily = pgTable(
  'tod_daily',
  {
    region: text('region').notNull(),
    fueltech: text('fueltech').notNull(),
    dayAnchor: date('day_anchor', { mode: 'date' }).notNull(),
    todBucket: integer('tod_bucket').notNull(),
    avgMw: doublePrecision('avg_mw').notNull(),
    sampleCount: integer('sample_count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.region, t.fueltech, t.dayAnchor, t.todBucket] })],
);

// Pre-aggregated daily values keyed by region + "kind" (mid_merit / peakers / battery / hydro).
// Region 'NEM' is the sum of all 5 NEM regions. Read directly to avoid the GROUP BY
// in the timeline endpoint.
export const todDailyGrouped = pgTable(
  'tod_daily_grouped',
  {
    region: text('region').notNull(),
    kind: text('kind').notNull(),
    dayAnchor: date('day_anchor', { mode: 'date' }).notNull(),
    todBucket: integer('tod_bucket').notNull(),
    mw: doublePrecision('mw').notNull(),
  },
  (t) => [primaryKey({ columns: [t.region, t.kind, t.dayAnchor, t.todBucket] })],
);
