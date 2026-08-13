const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const config = require('../config');

// The NYSDOT AADT dataset has no coordinates at all (confirmed against the
// live API) — only text: municipality, road_name, beginning/ending
// description. To do a genuine geographic spatial join against the NYC
// automated-count locations (which do have coordinates), we geocode each
// AADT station's road/municipality text once via OpenStreetMap's Nominatim
// (free, keyless) and cache the result to disk permanently. This is a
// best-effort, road-name-level geocode — not a precise segment location —
// so every result is labeled 'approximate' and the spatial join step is
// validated against known segments before it's trusted (see
// server/services/spatialJoin.js and test/spatialJoin.test.js).
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'nyc-traffic-volume-update-finder/1.0 (DOT planning dashboard; contact via project README)';
const MIN_REQUEST_SPACING_MS = 1100; // Nominatim usage policy: max 1 req/sec

let cache = null; // Map<queryKey, entry>
let lastRequestAt = 0;

function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function loadCache() {
  if (cache) return cache;
  ensureDataDir();
  try {
    const raw = fs.readFileSync(config.geocodeCachePath, 'utf8');
    cache = new Map(Object.entries(JSON.parse(raw)));
  } catch {
    cache = new Map();
  }
  return cache;
}

function saveCache() {
  // Best-effort, like datasetCache: an unwritable filesystem (a read-only
  // deploy target, a restricted container) must not break geocoding — the
  // in-memory cache still serves this process, it just won't outlive it.
  try {
    ensureDataDir();
    const tmpPath = `${config.geocodeCachePath}.tmp`;
    const obj = Object.fromEntries(cache.entries());
    fs.writeFileSync(tmpPath, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmpPath, config.geocodeCachePath); // atomic swap
  } catch (err) {
    console.warn('[geocode] could not persist cache:', err.message);
  }
}

// Keyed on road + the station's begin-point cross-street, not just road +
// municipality — many distinct AADT stations sit at different mileposts
// along the same named highway (e.g. several stations along "Staten Island
// Expressway"), and road+municipality alone would collapse them all onto
// one geocoded point. Stations here are the camelCase shape produced by
// aadtService.buildStationTrends (roadName/stateRoute/beginningDescription),
// not the raw snake_case Socrata rows.
function roadLabelOf(station) {
  return station.roadName || `${station.signing || ''} ${station.stateRoute || ''}`.trim();
}

function stationQueryKey(station) {
  const road = roadLabelOf(station);
  const crossStreet = station.beginningDescription || '';
  const place = station.municipality || station.county || '';
  return `${road}|${crossStreet}|${place}`.trim().toLowerCase();
}

async function rateLimitedGet(params) {
  const wait = MIN_REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  return axios.get(NOMINATIM_URL, {
    params: { ...params, format: 'json', limit: 1, countrycodes: 'us' },
    headers: { 'User-Agent': USER_AGENT },
    timeout: config.apiTimeoutMs,
  });
}

// NYSDOT's cross-street descriptions carry engineering suffixes ("EXIT",
// "OLAP", "UNDER", "OVER", "RAMP") that aren't part of the actual street
// name and make Nominatim queries fail to match. Stripping them turns e.g.
// "VICTORY BLVD EXIT" into "VICTORY BLVD", a real, geocodable street name.
function cleanCrossStreet(text) {
  if (!text) return '';
  return text
    .replace(/\b(EXIT|OLAP|UNDER|OVER|RAMP|CO\s*LINE|STATE\s*LINE)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Geocodes one AADT station's road/municipality text, trying a fallback query if the first yields nothing. */
async function geocodeStation(station) {
  const c = loadCache();
  const key = stationQueryKey(station);
  if (c.has(key)) return c.get(key);

  const roadLabel = roadLabelOf(station);
  const place = station.municipality || station.county || '';
  const crossStreet = cleanCrossStreet(station.beginningDescription);
  const attempts = [
    // Most specific first: road + the cross-street at the station's start point.
    crossStreet && `${roadLabel} & ${crossStreet}, ${place}, New York`,
    `${roadLabel}, ${place}, New York`,
    `${station.signing || ''} ${station.stateRoute || ''}, ${place}, New York`,
  ].filter((q) => q && q.replace(/[,&\s]/g, '').length > 0);

  let result = null;
  for (const q of attempts) {
    try {
      const { data } = await rateLimitedGet({ q });
      if (Array.isArray(data) && data.length > 0) {
        const hit = data[0];
        result = {
          lat: Number(hit.lat),
          lon: Number(hit.lon),
          confidence: 'approximate',
          source: 'nominatim',
          matchedQuery: q,
          displayName: hit.display_name,
          geocodedAt: new Date().toISOString(),
        };
        break;
      }
    } catch {
      // fall through to next attempt / eventually cache the miss
    }
  }

  if (!result) {
    result = { lat: null, lon: null, confidence: 'none', source: 'nominatim', geocodedAt: new Date().toISOString() };
  }

  c.set(key, result);
  saveCache();
  return result;
}

/**
 * Geocodes up to `batchSize` not-yet-cached stations, rate-limited to
 * Nominatim's usage policy. Intended to be called repeatedly (e.g. on an
 * interval) so a cold cache fills in progressively without blocking startup
 * or bulk-hammering the API.
 */
async function warmupBatch(stations, batchSize) {
  const c = loadCache();
  const pending = [];
  const seen = new Set();
  for (const s of stations) {
    const key = stationQueryKey(s);
    if (!c.has(key) && !seen.has(key)) {
      seen.add(key);
      pending.push(s);
    }
    if (pending.length >= batchSize) break;
  }
  for (const s of pending) {
    await geocodeStation(s);
  }
  return { geocoded: pending.length, remaining: null };
}

function cacheStats(stations) {
  const c = loadCache();
  const keys = new Set(stations.map(stationQueryKey));
  let cached = 0;
  for (const k of keys) if (c.has(k)) cached += 1;
  return { totalUniqueStations: keys.size, geocodedCount: cached };
}

/** Read-only cache lookup — never triggers a network call. Used at join time. */
function getCachedGeocode(station) {
  const c = loadCache();
  return c.get(stationQueryKey(station)) ?? null;
}

module.exports = {
  geocodeStation,
  warmupBatch,
  cacheStats,
  stationQueryKey,
  loadCache,
  getCachedGeocode,
};
