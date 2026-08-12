# NYC Traffic Volume Update Finder

A dashboard to inform NYC DOT workers of which tracker data point they should
update in their Automated Traffic Volume Counts dataset by comparing outdated
data with updated traffic data to see if anything needs changing.

It ranks traffic-volume count locations by how urgently they need to be
re-collected — combining historical AADT trend, a recent NYC automated-count
observation, and live TomTom conditions into one prioritized list.

## Running it

```bash
npm install
node server.js       # or: npm start
```

Open http://localhost:3000. The `.env` file (already populated) is read
automatically via dotenv; nothing else to configure to get started.

**First load is slow.** The default view (all 5 NYC boroughs) pages a
~290k-row Socrata dataset live — expect 30–90 seconds before the table
populates. After that it's cached in memory for 1 hour
(`DATASET_CACHE_TTL_MS`). Non-NYC counties are smaller and load faster.

Run the test suite (regression math, geo conversions, spatial-join
validation, deviation/priority formula) with:

```bash
npm test
```

## What it does

- Pulls historical **AADT** (Annual Average Daily Traffic) from the NYSDOT
  Open NY dataset, fits a linear trend per station, and projects it to the
  current year.
- Pulls recent **automated traffic-volume counts** from NYC Open Data,
  aggregates them into a comparable "recent AADT estimate."
- Spatially joins the two (they share no common ID — see below) and computes
  a deviation between the trended/expected value and the recent observation.
- Pulls **live TomTom conditions** on demand, only for the segment currently
  open in the detail view — never bulk.
- Scores and ranks every segment by `priority_score`, per the spec's formula:
  `age_years × |deviation_pct| × (is_explained ? 0.25 : 1)`.

## Architecture

```
server.js                        Express entrypoint
server/config.js                 env + tunable thresholds
server/services/socrata.js       shared SODA client (both datasets)
server/services/aadtService.js   AADT fetch + per-station trend fitting
server/services/nycCountsService.js   NYC counts fetch + daily-total estimate
server/services/geocodeService.js     AADT station geocoding (Nominatim) + disk cache
server/services/spatialJoin.js   AADT <-> NYC count nearest-neighbor matching
server/services/deviationEngine.js    the priority_score formula (pure fn)
server/services/segmentsRepository.js orchestration, caching, filtering
server/services/tomtomService.js      on-demand live conditions
server/routes/api.js             /api/segments, /api/segments/:county/:id, /api/counties
public/                          vanilla HTML/CSS/JS dashboard (no build step)
test/                            node:test unit + spatial-join validation tests
```

## Notable deviations from the literal spec — and why

**1. The `.env` base URLs aren't the classic SODA `/resource` shape.**
`OPEN_NY_BASE_URL` and `NY_OPEN_DATA_BASE_URL` are pre-baked Socrata **v3**
`query.json` URLs (one with a fixed SELECT already embedded), not the
`{base}/resource/{id}.json` shape the spec describes for a reusable
`$where/$select/$limit/$offset` module. Concatenating them as literally
described 400'd. Since the task said not to regenerate `.env`, the Socrata
client instead derives just the **origin** (protocol+host) from each
provided URL and talks to the standard, well-documented
`/resource/{datasetId}.json` SODA endpoint — confirmed working live against
both datasets. This is what makes one shared, parameterized client possible
for both sources, as the spec asked for.

**2. The spatial join required a design decision the user made explicitly.**
The AADT dataset (`6amx-2pbv`) has **no coordinates at all** — confirmed
against the live API and its sibling "by roadway segment" datasets — only
text (`municipality`, `road_name`, `beginning_description`). Presented with
three options, the user chose: **geocode AADT stations via the free,
keyless OpenStreetMap Nominatim service**, cache results to disk
(`data/geocode-cache.json`, gitignored), and do genuine radius-based
lat/long matching against the NYC counts dataset's `wktgeom` (itself
reprojected from NY State Plane feet / EPSG:2263 to WGS84 via `proj4`).
Only the 5 NYC-borough counties are geocoded (Bronx/Kings/New York/Queens/
Richmond) — that's the only scope where a match to NYC's automated-count
data is even possible.

**3. Geocoding precision is real-world limited, and the spatial join is
validated against it, not against an idealized radius.** Free-text
road-name geocoding of NYSDOT's abbreviated descriptions (e.g. "VICTORY
BLVD EXIT") doesn't always resolve to the specific station's cross-street —
it can fall back to a road-only match. Validated against a known real pair
(AADT station 22102 on Kingston Ave/Brooklyn vs. NYC count segment 42961),
the geocode landed **~650m** from the true station. The default match
radius (`SPATIAL_JOIN_RADIUS_METERS`, default 400m) and this validation
example are documented in `server/config.js` and exercised in
`test/spatialJoin.test.js`. Every match reports its actual `distanceMeters`
in the UI rather than a boolean, so a planner can judge it directly — this
also means proximity matching can occasionally pair an AADT station with a
NYC sensor on a **different nearby road** at a highway interchange (dense
overlapping expressways in the Bronx are the main place this shows up);
the reported distance and street name make that visible rather than hidden.
Geocoding runs incrementally in the background (rate-limited to Nominatim's
1 req/sec policy) so the spatial join gets more complete over time without
blocking startup — the dashboard shows a live "N/M stations geocoded"
progress note until it's done.

**4. Server-side aggregation, not bulk row transfer.** The NYC counts
dataset has ~1.9M rows; querying `$group` server-side (SoQL) collapses that
to a few thousand daily totals for the lookback window
(`NYC_COUNTS_LOOKBACK_YEARS`, default 3 years) instead of pulling raw
15-minute readings into Node.

**5. Retry-with-backoff on the Socrata client.** The configured
`API_TIMEOUT_MS` (15s) is occasionally too tight for a heavy server-side
aggregation query; rather than silently loosening the configured timeout,
the client retries transient timeouts/5xx up to 3 times with backoff.

## Filters & scope

- **County**: defaults to the 5 NYC boroughs (where all three sources
  overlap). Any of the other 57 NY counties can be selected for
  AADT-only historical/staleness browsing (no NYC spatial match possible
  there — labeled `not-applicable-outside-nyc`).
- **Min age (years)**, **min |deviation| %**, **trend confidence** — as
  specified.
- Priority tiers on the list/map (Critical/Serious/Watch/Low) are computed
  **relative to the currently displayed set** (quartile-style), since
  `priority_score` is an unbounded product with no fixed absolute scale.

## Known limitations

- The live NYSDOT AADT data in this dataset caps out at **2019** for NYC
  boroughs — every segment in the default scope is currently ≥7 years
  stale. That's a genuine finding, not a bug in the app.
- Segments with no geocode yet, or no NYC count within the match radius,
  are shown with `spatialMatchStatus` clearly labeled (`geocode-pending`,
  `geocode-failed`, `no-match-within-radius`) rather than dropped.
- TomTom Flow Segment Data is speed/congestion, not volume — used only as
  contextual "is there something going on here" signal in the detail view,
  per spec.
