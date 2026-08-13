#!/usr/bin/env node
/**
 * Build-time data snapshot.
 *
 * Fetches the AADT stations for every NYC borough plus the NYC counts
 * aggregation and writes them to `data/dataset-snapshot.json`, in exactly the
 * shape datasetCache reads. Runtime then serves from that file instead of
 * paging ~95k rows per county on the first request.
 *
 * This is what makes a serverless deploy viable at all: a cold county load
 * measured 30-75s against a 60s function ceiling, and serverless instances
 * share no memory, so *every* cold instance would pay that cost and time out.
 * Moving the fetch into the build means requests only ever read a local file.
 *
 * Run by `npm run build`, which Vercel executes automatically. Safe to run
 * locally too — it just refreshes the snapshot.
 *
 * Failures are non-fatal by design: a snapshot is an optimization, and a
 * transient Socrata outage should not break the deploy. The app falls back to
 * fetching on demand, which still works on a persistent host.
 */
const fs = require('node:fs');
const path = require('node:path');
const aadtService = require('../server/services/aadtService');
const nycCountsService = require('../server/services/nycCountsService');
const { COUNTY_TO_BOROUGH } = require('../server/services/spatialJoin');

const NYC_COUNTIES = Object.keys(COUNTY_TO_BOROUGH);
const OUT_PATH = path.join(__dirname, '..', 'data', 'dataset-snapshot.json');
const CACHE_VERSION = 1;

async function main() {
  const startedAt = Date.now();
  const entries = {};
  const stamp = () => ({ loadedAt: Date.now() });

  for (const county of NYC_COUNTIES) {
    const t = Date.now();
    const rows = await aadtService.fetchCountyRows(county);
    const stations = aadtService.buildStationTrends(rows);
    entries[`county:${county}`] = { ...stamp(), value: stations };
    console.log(
      `  ${county}: ${rows.length.toLocaleString()} rows -> ${stations.length} stations ` +
        `(${((Date.now() - t) / 1000).toFixed(1)}s)`
    );
  }

  const t = Date.now();
  const dailyRows = await nycCountsService.fetchRecentDailyTotals();
  const estimates = nycCountsService.estimateAadtFromDailyTotals(dailyRows);
  entries.nycCounts = { ...stamp(), value: estimates };
  console.log(
    `  NYC counts: ${dailyRows.length.toLocaleString()} daily totals -> ` +
      `${estimates.length} segment estimates (${((Date.now() - t) / 1000).toFixed(1)}s)`
  );

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ version: CACHE_VERSION, entries, timings: {} }), 'utf8');

  const sizeMb = (fs.statSync(OUT_PATH).size / 1048576).toFixed(1);
  console.log(
    `\nSnapshot written: ${OUT_PATH} (${sizeMb} MB) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
}

main().catch((err) => {
  console.warn(`\n[build-snapshot] FAILED: ${err.message}`);
  console.warn('Continuing without a snapshot — the app will fetch on demand at runtime.');
  process.exit(0); // deliberately not a build failure
});
