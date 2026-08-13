const path = require('node:path');
require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// The .env file ships pre-baked Socrata v3 "query.json" URLs scoped to one
// specific dataset each (and, for AADT, with a fixed SELECT already embedded).
// That shape can't be reused as a generic "base + dataset id" pair the way the
// classic SODA REST API works, so we derive just the origin (protocol+host)
// from the provided URL and talk to the standard `/resource/{id}.json`
// endpoint instead. This keeps the .env untouched while still giving the
// shared Socrata client a single consistent, parameterizable shape
// ($where/$select/$limit/$offset/$order) for both datasets.
function originOf(url) {
  return new URL(url).origin;
}

const currentYear = new Date().getFullYear();

module.exports = {
  port: process.env.PORT || 3000,
  currentYear,

  tomtom: {
    apiKey: requireEnv('TOMTOM_API_KEY'),
    baseUrl: requireEnv('TOMTOM_BASE_URL'),
  },

  openNy: {
    origin: originOf(requireEnv('OPEN_NY_BASE_URL')),
    datasetId: requireEnv('OPEN_NY_AADT_DATASET_ID'),
    appToken: requireEnv('OPEN_NY_APP_TOKEN'),
  },

  nycOpenData: {
    origin: originOf(requireEnv('NY_OPEN_DATA_BASE_URL')),
    datasetId: requireEnv('NYC_TRAFFIC_VOLUME_DATASET_ID'),
    appToken: requireEnv('NY_OPEN_DATA_APP_TOKEN'),
  },

  // 511NY event feed. Unlike the two Socrata URLs above, this one is a plain
  // API root — the endpoint name, key and format are query params appended at
  // request time (see fiveElevenService), so the key never lives inside a URL
  // string that could end up in a log line.
  fiveEleven: {
    baseUrl: requireEnv('FIVE_ELEVEN_BASE_URL').replace(/\/+$/, ''),
    apiKey: requireEnv('FIVE_ELEVEN_API_KEY'),
  },

  apiTimeoutMs: Number(process.env.API_TIMEOUT_MS) || 15000,

  // NYSDOT's official Site Dashboard. Link target only — this app never
  // requests it (see server/utils/nysdotLinks.js for why). Overridable
  // without a code change in case NYSDOT moves or renames the node.
  nysdotDashboard: {
    baseUrl: process.env.NYSDOT_DASHBOARD_BASE_URL || 'https://nysdottrafficdata.drakewell.com',
    node: process.env.NYSDOT_DASHBOARD_NODE || 'NYSDOT_SC',
  },

  // Analytical thresholds (spec calls out ~15-20%; keep configurable at
  // runtime via query params, this is just the default).
  deviationThresholdPct: Number(process.env.DEVIATION_THRESHOLD_PCT) || 17.5,
  staleAgeThresholdYears: Number(process.env.STALE_AGE_THRESHOLD_YEARS) || 5,
  maxCleanExtrapolationYears: Number(process.env.MAX_CLEAN_EXTRAPOLATION_YEARS) || 7,
  shortCountWindowDays: Number(process.env.SHORT_COUNT_WINDOW_DAYS) || 7,
  nycCountsLookbackYears: Number(process.env.NYC_COUNTS_LOOKBACK_YEARS) || 3,

  // Spatial join. The AADT source has no coordinates, so stations are
  // geocoded from road-name text (see geocodeService) — a road-only geocode
  // (when the cross-street-specific query doesn't resolve) can land several
  // hundred meters from the station's true position along a long avenue.
  // Validated against a known real segment (Kingston Ave/Brooklyn) at ~650m
  // off, so 200m would silently miss real matches; every match still
  // reports its actual distanceMeters so a planner can judge it directly.
  spatialJoinRadiusMeters: Number(process.env.SPATIAL_JOIN_RADIUS_METERS) || 400,

  // Radius for matching a 511NY event to a geocoded AADT station. Same
  // default as the count join, and for the same reason (the station geocode
  // itself is only road-accurate). 511 events are point-located at one end of
  // what may be a long work zone, so this is deliberately not tighter.
  eventMatchRadiusMeters: Number(process.env.EVENT_MATCH_RADIUS_METERS) || 400,

  // 511NY events change through the day (incidents open/clear), so this is a
  // much shorter TTL than the two historical datasets' 1 hour.
  eventsCacheTtlMs: Number(process.env.EVENTS_CACHE_TTL_MS) || 5 * 60 * 1000, // 5m

  // On-disk caches (gitignored)
  dataDir: path.join(__dirname, '..', 'data'),
  geocodeCachePath: path.join(__dirname, '..', 'data', 'geocode-cache.json'),
  datasetCachePath: path.join(__dirname, '..', 'data', 'dataset-cache.json'),
  datasetCacheTtlMs: Number(process.env.DATASET_CACHE_TTL_MS) || 60 * 60 * 1000, // 1h
};
