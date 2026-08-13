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
- Pulls the **511NY event feed** (`GetEvents`) in bulk once every 5 minutes and
  matches active roadwork/closures/incidents to each station by proximity —
  this is what supplies `is_explained` below.
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
server/services/fiveElevenService.js  511NY event feed -> is_explained input
server/routes/api.js             /api/segments, /api/segments/:county/:id, /api/counties
public/                          vanilla HTML/CSS/JS dashboard (no build step)
test/                            node:test unit + spatial-join validation tests
```

## Deploying

The same build runs locally, in a container, and on a serverless host. Three
things adapt at startup:

- **Where caches are written** — `DATA_DIR`, else `<project>/data`, else the OS
  temp directory. The first writable one wins (`server/utils/dataDir.js`).
- **Whether the process listens** — `server.js` binds a port only when run
  directly, and exports the Express app otherwise, so a serverless host can
  import it (`api/index.js`).
- **Whether the geocode warmup runs** — on by default when the cache directory
  is persistent, off when it isn't, since a serverless invocation is killed
  after its response and would burn Nominatim's rate limit for nothing.
  Override with `ENABLE_GEOCODE_WARMUP`.

**Set the environment variables on the host.** `.env` is gitignored and never
uploaded; `server/config.js` throws at import if any required key is missing,
which surfaces as every request returning 500. See `.env.example`.

### Persistent host (recommended) — Render / Railway / Fly.io / Docker

This is what the app is designed for. Use the `Dockerfile`, mount a volume, and
point `DATA_DIR` at it so the dataset and geocode caches survive restarts.
Nothing else needs changing.

**Render** has a blueprint ready: New → Blueprint → point at this repo.
`render.yaml` builds the Dockerfile, attaches a 1 GB disk at `/data`, sets
`DATA_DIR` to match, health-checks `/api/health`, and prompts for the four API
keys (they are marked `sync: false` so they never live in the repo).

Two things to know before deploying there:

- **A disk requires a paid instance type.** Render's free tier has no
  persistent storage *and* sleeps when idle, so every wake would pay the full
  30-90s cold load. The blueprint specifies `plan: starter` for that reason.
- **`DATASET_CACHE_TTL_MS` is set to 24h**, not the 1h default. The upstream
  AADT data is frozen at 2019 and NYC counts add ~100 segments a year, so a
  long TTL costs nothing in freshness and makes restarts near-instant.

`.dockerignore` keeps `.env`, `node_modules` and the local `data/` cache out of
the image — secrets are supplied by the host at runtime, and a stale cached
dataset baked into an image would ship old data while masking a broken fetch.

### Serverless (Vercel)

`vercel.json` and `api/index.js` make it deploy and run, but two limits are
inherent to the platform rather than fixable by configuration:

1. **Cold loads can exceed the function timeout.** A first-time county load
   pages ~95k rows; Queens measured 75s against a 60s ceiling (10s default on
   Hobby). Warm instances serve from cache in ~30ms, so behaviour is
   inconsistent rather than uniformly broken.
2. **Instances share no memory or disk.** The in-process dataset caches and the
   progress tracker are per-instance, and `/tmp` is wiped between them. The
   loading bar polls a *different invocation* than the one doing the work, so
   it will usually report nothing.

Making Vercel work properly means moving the dataset fetch out of request time
— precompute the joined, scored segments on a schedule into a shared store
(Vercel KV/Postgres) and serve reads from it. Until then, prefer a persistent
host.

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

**6. 511NY supplies `is_explained`; TomTom stayed as display context.**
The priority formula's `is_explained` term needs a *reason* ("there is a work
zone here"), not a speed reading. TomTom Flow Segment Data can only say
traffic is slow, not why, and it's a per-point on-demand call — too expensive
to run for every row of the list, which is where the ranking is decided. So
`hasActiveConstruction` is fed from 511NY's `GetEvents`, which returns the
whole state's events in one bulk call (~2.4k statewide, ~390 active in the
five boroughs) and can therefore be applied to every segment. TomTom was kept
alongside it, unchanged, in the detail drawer: the two answer different
questions ("is something happening here" vs. "how bad is it right now").

Only `roadwork`, `closures` and `accidentsAndIncidents` de-weight a segment.
`specialEvents` (concerts, parades, ballgames) and `transitOperations` (bus
stop bypasses) are displayed in the drawer but deliberately excluded from the
formula — a one-evening event is not a reason to stop trusting a multi-year
AADT baseline.

**7. 511NY timestamps are DD/MM/YYYY, and it matters.** The feed's
`StartDate`/`PlannedEndDate` fields use day-first ordering while the
`Description` text of the same record uses US month-first — verified against
the live feed, where 1508 of ~2400 `StartDate` values have a leading
component > 12 and none have a second component > 12. Passing these to
`new Date()` parses them as MM/DD and shifts events by months, which would
silently corrupt the active-now filter, so `fiveElevenService.parse511Date`
parses them explicitly (covered in `test/fiveEleven.test.js`). Most events
carry no `PlannedEndDate` at all — that's how 511 represents open-ended
long-term construction, so those are treated as ongoing and flagged
`isOpenEnded` in the UI rather than silently dropped or silently trusted.

**8. Current-year volume is linked to, not scraped.** NYSDOT's Site Dashboard
(Drakewell-hosted, separate from the ArcGIS services) carries current-year
AADT trend plus hourly and daily volume per station — years newer than
anything NYSDOT publishes through an open API, where NYC data caps at 2019
(AADT), 2021 (ArcGIS short counts) and 2022 (HDSB bulk CSVs). It is
deliberately not machine readable: reCAPTCHA Enterprise on every page load
and `Disallow: /` in robots.txt. So the app doesn't fetch it. Instead every
segment carries an `officialDashboardUrl` and the detail drawer links out to
it, putting the authoritative current numbers one click from the ranking
without automating a system that asks not to be automated. The dashboard's
`cosit` parameter is just the station number padded to six digits plus six
zeros (`54255` -> `054255000000`), verified against the ArcGIS AADT layer and
pinned in `test/nysdotLinks.test.js`. Programmatic access to that data is a
request to make of NYSDOT Traffic Monitoring
(MO-TrafficDataViewer@dot.state.ny.us), not something to work around.

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
- **511NY events are point-located, but work zones are corridors.** Each event
  carries a single lat/long (plus a `MapEncodedPolyline` the app does not
  currently decode), so a multi-mile construction project is matched from one
  end of it. Combined with the road-name-level station geocode, this means an
  event on one road can be credited to a station on a *different* nearby road —
  the same interchange problem the AADT↔counts join has, and it shows up in the
  same places (dense overlapping expressways in the Bronx). Every matched event
  therefore displays its roadway name and real distance, so a planner can see
  "roadwork on OLYMPIA BLVD (329m)" against a station on Baden Pl and judge it.
  Decoding the polyline and matching against the corridor is the obvious
  improvement if this proves too loose in practice.
- Because `is_explained` cuts `priority_score` to 25%, a false event match
  pushes a genuinely stale segment *down* the list. The 511 tag is shown
  in the list view (not just the drawer) specifically so that de-weighting is
  visible rather than silent.
