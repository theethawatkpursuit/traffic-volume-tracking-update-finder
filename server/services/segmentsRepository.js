const config = require('../config');
const aadtService = require('./aadtService');
const nycCountsService = require('./nycCountsService');
const geocodeService = require('./geocodeService');
const { joinStationsToCounts, COUNTY_TO_BOROUGH } = require('./spatialJoin');
const { computeDeviation } = require('../services/deviationEngine');

const NYC_COUNTIES = Object.keys(COUNTY_TO_BOROUGH); // Bronx, Kings, New York, Queens, Richmond
const ALL_NY_COUNTIES = [
  'Albany', 'Allegany', 'Bronx', 'Broome', 'Cattaraugus', 'Cayuga', 'Chautauqua', 'Chemung',
  'Chenango', 'Clinton', 'Columbia', 'Cortland', 'Delaware', 'Dutchess', 'Erie', 'Essex',
  'Franklin', 'Fulton', 'Genesee', 'Greene', 'Hamilton', 'Herkimer', 'Jefferson', 'Kings',
  'Lewis', 'Livingston', 'Madison', 'Monroe', 'Montgomery', 'Nassau', 'New York', 'Niagara',
  'Oneida', 'Onondaga', 'Ontario', 'Orange', 'Orleans', 'Oswego', 'Otsego', 'Putnam', 'Queens',
  'Rensselaer', 'Richmond', 'Rockland', 'Saint Lawrence', 'Saratoga', 'Schenectady', 'Schoharie',
  'Schuyler', 'Seneca', 'Steuben', 'Suffolk', 'Sullivan', 'Tioga', 'Tompkins', 'Ulster', 'Warren',
  'Washington', 'Wayne', 'Westchester', 'Wyoming', 'Yates',
];

const countyCache = new Map(); // county -> { stations, loadedAt }
let nycCountsCache = null; // { estimates, index, loadedAt }
let geocodeWarmupTimer = null;

async function getNycCountEstimates() {
  if (nycCountsCache && Date.now() - nycCountsCache.loadedAt < config.datasetCacheTtlMs) {
    return nycCountsCache;
  }
  const dailyRows = await nycCountsService.fetchRecentDailyTotals();
  const estimates = nycCountsService.estimateAadtFromDailyTotals(dailyRows);
  nycCountsCache = { estimates, loadedAt: Date.now() };
  return nycCountsCache;
}

async function getCountyStations(county) {
  const cached = countyCache.get(county);
  if (cached && Date.now() - cached.loadedAt < config.datasetCacheTtlMs) {
    return cached.stations;
  }
  const rows = await aadtService.fetchCountyRows(county);
  const stations = aadtService.buildStationTrends(rows);
  countyCache.set(county, { stations, loadedAt: Date.now() });
  return stations;
}

/** Builds the fully-joined + scored segment list for a county. */
async function buildCountySegments(county) {
  const stations = await getCountyStations(county);
  const isNycCounty = NYC_COUNTIES.includes(county);

  let estimatesBySegmentDirection = new Map();
  let joinByStationId = new Map();
  if (isNycCounty) {
    const { estimates } = await getNycCountEstimates();
    for (const e of estimates) {
      estimatesBySegmentDirection.set(`${e.segmentId}|${e.direction}`, e);
    }
    const joins = joinStationsToCounts(stations, estimates);
    for (const j of joins) joinByStationId.set(j.stationId, j);
  }

  return stations.map((station) => {
    const join = joinByStationId.get(station.stationId);
    const nycEstimate = join?.spatialMatch
      ? estimatesBySegmentDirection.get(`${join.spatialMatch.segmentId}|${join.spatialMatch.direction}`)
      : null;

    const deviation = computeDeviation({ trend: station.trend, nycEstimate });

    return {
      stationId: station.stationId,
      county: station.county,
      municipality: station.municipality,
      roadName: station.roadName,
      signing: station.signing,
      stateRoute: station.stateRoute,
      beginningDescription: station.beginningDescription,
      endingDescription: station.endingDescription,
      history: station.history,
      trend: station.trend,
      spatialMatch: join?.spatialMatch ?? null,
      spatialMatchStatus: isNycCounty
        ? (join?.spatialMatchStatus ?? 'geocode-pending')
        : 'not-applicable-outside-nyc',
      stationLocation:
        join?.stationLat != null ? { lat: join.stationLat, lon: join.stationLon, confidence: join.geocodeConfidence } : null,
      nycEstimate: nycEstimate
        ? {
            aadtRecentEstimate: nycEstimate.aadtRecentEstimate,
            observedDayCount: nycEstimate.observedDayCount,
            isShortCountEstimate: nycEstimate.isShortCountEstimate,
            observationWindow: nycEstimate.observationWindow,
          }
        : null,
      ...deviation,
    };
  });
}

async function listSegments({
  county,
  ageThresholdYears,
  deviationThresholdPct,
  confidenceLevel,
} = {}) {
  const counties = county ? [county] : NYC_COUNTIES; // default scope: the five NYC boroughs (strongest coverage)
  const all = (await Promise.all(counties.map(buildCountySegments))).flat();

  let filtered = all;
  if (ageThresholdYears != null) {
    filtered = filtered.filter((s) => (s.confidence.ageYears ?? 0) >= Number(ageThresholdYears));
  }
  if (deviationThresholdPct != null) {
    const t = Number(deviationThresholdPct);
    filtered = filtered.filter((s) => s.deviationPct != null && Math.abs(s.deviationPct) > t);
  }
  if (confidenceLevel) {
    filtered = filtered.filter((s) => s.confidence.trendConfidence === confidenceLevel);
  }

  filtered.sort((a, b) => b.priorityScore - a.priorityScore);
  return filtered;
}

function summarize(segments) {
  const total = segments.length;
  if (total === 0) {
    return { total: 0, pctOlderThan5Years: 0, pctStaleWithSignificantUnexplainedDeviation: 0 };
  }
  const staleThreshold = config.staleAgeThresholdYears;
  const stale = segments.filter((s) => (s.confidence.ageYears ?? 0) > staleThreshold);
  const staleWithSignificantUnexplained = stale.filter(
    (s) => s.isDeviationSignificant === true && s.isExplained === false
  );
  return {
    total,
    pctOlderThan5Years: Math.round((stale.length / total) * 1000) / 10,
    pctStaleWithSignificantUnexplainedDeviation:
      stale.length === 0 ? 0 : Math.round((staleWithSignificantUnexplained.length / stale.length) * 1000) / 10,
  };
}

async function getSegmentDetail(county, stationId) {
  const segments = await buildCountySegments(county);
  return segments.find((s) => String(s.stationId) === String(stationId)) ?? null;
}

/**
 * Geocodes not-yet-cached NYC-county stations in the background, rate-limited
 * batch by batch. Self-schedules the next batch only after the current one
 * finishes (each batch's own Nominatim calls already take
 * batchSize * ~1.1s, so a fixed setInterval would overlap runs) — a short
 * `pauseMs` gap between batches is just being a considerate API citizen.
 */
function startGeocodeWarmup({ batchSize = 50, pauseMs = 3000 } = {}) {
  if (geocodeWarmupTimer) return;
  let stopped = false;

  async function runBatch() {
    try {
      const allNycStations = (await Promise.all(NYC_COUNTIES.map(getCountyStations))).flat();
      const { geocoded } = await geocodeService.warmupBatch(allNycStations, batchSize);
      if (geocoded === 0) {
        console.log('[geocode-warmup] complete — all NYC-county AADT stations geocoded.');
        stopped = true;
        return;
      }
      console.log(`[geocode-warmup] geocoded ${geocoded} more stations.`);
    } catch (err) {
      console.error('[geocode-warmup] batch failed:', err.message);
    }
    if (!stopped) {
      geocodeWarmupTimer = setTimeout(runBatch, pauseMs);
      geocodeWarmupTimer.unref?.();
    }
  }

  runBatch();
}

function geocodeProgress(stations) {
  return geocodeService.cacheStats(stations);
}

/** Geocode progress across whichever counties a /segments request is scoped to. */
async function geocodeProgressForScope(county) {
  const counties = county ? [county] : NYC_COUNTIES;
  const relevant = counties.filter((c) => NYC_COUNTIES.includes(c));
  if (relevant.length === 0) return { totalUniqueStations: 0, geocodedCount: 0 };
  const stations = (await Promise.all(relevant.map(getCountyStations))).flat();
  return geocodeService.cacheStats(stations);
}

module.exports = {
  NYC_COUNTIES,
  ALL_NY_COUNTIES,
  listSegments,
  summarize,
  getSegmentDetail,
  getCountyStations,
  startGeocodeWarmup,
  geocodeProgress,
  geocodeProgressForScope,
};
