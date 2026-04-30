import { OpenElectricityClient, OpenElectricityError, NoDataFound } from 'openelectricity';
import type { UnitFueltechType } from 'openelectricity';
import type { NetworkCode } from '../regions';
import { toNaiveLocal } from './paginate';

export type FetchedRow = {
  ts: Date;
  region: string;
  fueltech: string;
  powerMw: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one window of 5m power data and flatten to insertable rows.
 * Retries up to 5 times with exponential backoff on 429 / 5xx.
 */
export async function fetchWindow(
  client: OpenElectricityClient,
  args: {
    network: NetworkCode;
    tzOffsetHours: number;
    region: string;
    fueltechs: UnitFueltechType[];
    dateStart: Date;
    dateEnd: Date;
  },
): Promise<FetchedRow[]> {
  const { network, tzOffsetHours, region, fueltechs, dateStart, dateEnd } = args;
  let attempt = 0;
  while (true) {
    try {
      const { response } = await client.getNetworkData(network, ['power'], {
        interval: '5m',
        dateStart: toNaiveLocal(dateStart, tzOffsetHours),
        dateEnd: toNaiveLocal(dateEnd, tzOffsetHours),
        network_region: region,
        secondaryGrouping: ['fueltech'],
        fueltech: fueltechs,
      });
      const rows: FetchedRow[] = [];
      const allowed = new Set<string>(fueltechs);
      for (const block of response.data) {
        for (const series of block.results) {
          const ft = String(series.columns.fueltech ?? '');
          if (!allowed.has(ft)) continue;
          for (const [ts, val] of series.data) {
            if (val == null) continue;
            rows.push({ ts: new Date(ts), region, fueltech: ft, powerMw: val });
          }
        }
      }
      return rows;
    } catch (err) {
      // 404: the API has no data for this window (e.g. a tiny tail window
      // where the most recent 5min bucket hasn't landed yet). Treat as empty.
      if (err instanceof NoDataFound) return [];
      const status = err instanceof OpenElectricityError ? err.statusCode : undefined;
      const transient = status === 429 || (status !== undefined && status >= 500 && status < 600);
      if (!transient || attempt >= 4) throw err;
      const delay = 500 * 2 ** attempt;
      console.warn(
        `  [retry ${attempt + 1}/5] ${region} ${toNaiveLocal(dateStart, tzOffsetHours)} status=${status ?? '?'} sleep=${delay}ms`,
      );
      await sleep(delay);
      attempt += 1;
    }
  }
}
