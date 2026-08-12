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

  apiTimeoutMs: Number(process.env.API_TIMEOUT_MS) || 15000,

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

  // On-disk caches (gitignored)
  dataDir: path.join(__dirname, '..', 'data'),
  geocodeCachePath: path.join(__dirname, '..', 'data', 'geocode-cache.json'),
  datasetCachePath: path.join(__dirname, '..', 'data', 'dataset-cache.json'),
  datasetCacheTtlMs: Number(process.env.DATASET_CACHE_TTL_MS) || 60 * 60 * 1000, // 1h
};
