// Per-region metadata. Single source of truth for the facts that vary between
// NEM (5 sub-regions, AEST) and WEM (single region, AWST). Everything else —
// fueltech grouping, bin layout, matview shape — is identical.
//
// 'NEM' is a synthetic aggregate (sum of NSW1+QLD1+SA1+TAS1+VIC1, computed in
// tod_daily_grouped). 'WEM' is a real OE region whose code happens to equal
// the network code.

export type NetworkCode = 'NEM' | 'WEM';

export const REGIONS = ['NEM', 'NSW1', 'QLD1', 'SA1', 'TAS1', 'VIC1', 'WEM'] as const;
export type Region = (typeof REGIONS)[number];

export type RegionMeta = {
  network: NetworkCode;
  tzOffsetHours: number;
  pgTimezone: string;
  startOfTime: Date;
  isAggregate: boolean;
};

// 2010-01-01: pulled back from the original 2017-12-01 ("Hornsdale online")
// floor so the 12-month rolling window at the displayed start (2017-12-01) is
// fully populated with real preceding data instead of ramping up from a
// partial window. WEM data is 30-minute resolution before the 2023-10-01 WEM
// Reform Program switch to 5-minute dispatch (and pre-2021 NEM dispatch is
// natively 5-min even though settlement was 30-min); ingest detects cadence
// from the response and linearly interpolates 30m samples to 5m rows.
const ALL_START = new Date('2010-01-01T00:00:00Z');

const NEM_DEFAULT: Omit<RegionMeta, 'isAggregate'> = {
  network: 'NEM',
  tzOffsetHours: 10,
  pgTimezone: 'Australia/Brisbane',
  startOfTime: ALL_START,
};

const REGION_META: Record<Region, RegionMeta> = {
  NEM: { ...NEM_DEFAULT, isAggregate: true },
  NSW1: { ...NEM_DEFAULT, isAggregate: false },
  QLD1: { ...NEM_DEFAULT, isAggregate: false },
  SA1: { ...NEM_DEFAULT, isAggregate: false },
  TAS1: { ...NEM_DEFAULT, isAggregate: false },
  VIC1: { ...NEM_DEFAULT, isAggregate: false },
  WEM: {
    network: 'WEM',
    tzOffsetHours: 8,
    pgTimezone: 'Australia/Perth',
    startOfTime: ALL_START,
    isAggregate: false,
  },
};

export function regionMeta(region: Region): RegionMeta {
  return REGION_META[region];
}

export const INGEST_REGIONS: Region[] = REGIONS.filter((r) => !REGION_META[r].isAggregate);
