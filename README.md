# Time-of-day generation profile — Gas & Batteries

A static visualisation of how the daily dispatch shape of gas peakers, mid-merit gas, and grid batteries has evolved across Australia's NEM and WEM since the first big battery (Hornsdale) came online in late 2017.

The site is a fully static Next.js export (no server runtime) — all the heavy lifting happens in offline scripts, and the browser just fetches a small binary per region and draws stacked-area charts with D3.

## Data source & attribution

All generation data comes from **[TSI Open Electricity](https://openelectricity.org.au)** — Open Electricity is a project of **The Superpower Institute (TSI)**.

If you fork this project, reuse the binaries in `public/data/`, or republish derived figures, please credit **"TSI Open Electricity"** and link to <https://openelectricity.org.au>. Refer to Open Electricity's site for their data terms.

The ingest pipeline pulls data via the official [`openelectricity`](https://www.npmjs.com/package/openelectricity) npm SDK against `platform.openelectricity.org.au`. Running ingest yourself requires an API key in `.env.local` (`OPENELECTRICITY_API_KEY`); the static binaries already in `public/data/` are sufficient to run the site in dev with no API key.

**Coverage**

- Networks: NEM (sub-regions NSW1, QLD1, SA1, TAS1, VIC1) and WEM.
- Resolution: 5-minute dispatch.
- Date range: 2017-12-01 → present.
- Fueltechs: `gas_ccgt`, `gas_ocgt`, `gas_recip`, `gas_steam`, `gas_wcmg`, `battery_discharging`, `hydro`.

## How the data is crunched

The pipeline runs in four offline stages, then the browser does a final rolling-average pass on demand.

### 1. Ingest — `scripts/ingest.ts`

Pulls 5-minute power samples from the Open Electricity API and stores them in Postgres.

- Paginates each region in 8-day windows (the API's max for 5-minute data) — see `src/lib/oe/paginate.ts`.
- Retries 429 / 5xx responses with exponential backoff; treats 404 / NoDataFound as an empty window — see `src/lib/oe/fetcher.ts`.
- Deduplicates the overlap between adjacent windows.
- Linearly interpolates 30-minute legacy samples up to 5-minute rows where the API returns the coarser cadence (notably WEM before its 2023-10-01 switch to 5-minute dispatch).
- Upserts into `power_5m (ts, region, fueltech, power_mw)` in 1000-row batches and records each region's cursor in `ingest_state`, so reruns are idempotent and only fetch what's new.

### 2. Aggregate — `scripts/refresh-aggregates.ts`

Builds three timezone-aware Postgres materialised views that bucket every timestamp into one of 288 five-minute time-of-day slots in the region's local time (AEST for NEM, AWST for WEM):

- `tod_weekly` — per-week rolling averages.
- `tod_daily` — per-calendar-day averages, by fueltech.
- `tod_daily_grouped` — per-day averages collapsed into four series:
  - `mid_merit` — `gas_ccgt` + `gas_steam` + `gas_wcmg`
  - `peakers` — `gas_ocgt` + `gas_recip`
  - `battery` — `battery_discharging`
  - `hydro`
  - Also synthesises a `'NEM'` region as the sum of the five NEM sub-regions.

### 3. Static export — `scripts/generate-static.ts`

Serialises `tod_daily_grouped` into compact little-endian `Int16` binary files (one per region) plus a manifest:

- Files: `public/data/tod-{REGION}-{YYYYMMDD}.bin` (one per region).
- Layout: `numSeries × numDays × 288` MW values, series-major.
- Manifest: `public/data/manifest.json` lists series order, date range, bucket count, and file names.
- Roughly ~5 MB per region for the full ~3000-day history.

### 4. Client — `src/lib/tod/timeline-client.ts` + `src/app/components/`

The browser fetches the manifest and the selected region's binary on demand, then computes 28-day or 12-month rolling-window averages on the fly. Charts are D3 stacked-area (`TodChart.tsx`); `TodAnimatedView.tsx` drives the slider/animation; `TodSmallMultiples.tsx` renders the year-by-year grid. There is no API route — `next.config.ts` uses `output: 'export'` and the site is published to GitHub Pages via `pnpm deploy:pages`.

## Repo layout

```
scripts/
  ingest.ts               — fetch & ingest 5-minute power data
  refresh-aggregates.ts   — (re)build materialised views
  generate-static.ts      — write per-region Int16 binaries + manifest
  generate-og-image.tsx   — build the OG share image

src/lib/
  oe/                     — Open Electricity SDK wrapper, retry, pagination
  tod/                    — client-side binary loader + rolling-window calc
  time/                   — TOD bucket ↔ label helpers
  regions.ts              — region metadata (network, timezone, agg rules)

src/db/                   — Drizzle schema and pool
src/app/components/       — TodView, TodChart, animation, small multiples, etc.
public/data/              — manifest.json + per-region .bin files (committed)
```

## Developer setup

Prereqs: Node, pnpm, a local Postgres (only needed if you want to re-run the pipeline), and — for ingest — an Open Electricity API key.

`.env.local`:

```
DATABASE_URL=postgres://...
OPENELECTRICITY_API_KEY=...
```

Run the dev server:

```bash
pnpm dev
```

Open <http://localhost:3000>.

The committed binaries in `public/data/` are enough to use the app locally without touching Postgres or the OE API.

### Pipeline scripts

| Command | What it does |
| --- | --- |
| `pnpm db:push` | Apply the Drizzle schema to your local Postgres. |
| `pnpm ingest` | Catch `power_5m` up to "now" from the Open Electricity API. |
| `pnpm refresh` | Rebuild the `tod_*` materialised views. |
| `pnpm generate-static` | Re-emit `public/data/*.bin` and `manifest.json`. |
| `pnpm build` | Production static export to `out/`. |
| `pnpm deploy:pages` | Build with `NEXT_PUBLIC_BASE_PATH=/gas-battery` and push to GitHub Pages. |

A typical refresh cycle is `pnpm ingest && pnpm refresh && pnpm generate-static`.

## A note for AI agents

This project pins **Next.js 16**, which has breaking changes versus the version most LLMs were trained on. Read `AGENTS.md` (and the relevant guide under `node_modules/next/dist/docs/`) before writing code.
