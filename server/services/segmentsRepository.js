const config = require('../config');
const aadtService = require('./aadtService');
const nycCountsService = require('./nycCountsService');
const geocodeService = require('./geocodeService');
const fiveElevenService = require('./fiveElevenService');
const datasetCache = require('./datasetCache');
const progress = require('./progressTracker');
const { joinStationsToCounts, COUNTY_TO_BOROUGH } = require('./spatialJoin');
const { computeDeviation } = require('../services/deviationEngine');
const { siteDashboardUrl } = require('../utils/nysdotLinks');

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

// Two-level caching. The in-memory Maps stay the hot path; datasetCache is a
// disk layer beneath them so a process restart doesn't re-page the ~290k-row
// AADT query and the grouped NYC counts aggregation before the first request
// can be served. Both levels share `datasetCacheTtlMs`.
const countyCache = new Map(); // county -> { stations, loadedAt }
let nycCountsCache = null; // { estimates, index, loadedAt }
let geocodeWarmupTimer = null;

const NYC_COUNTS_CACHE_KEY = 'nycCounts';
const countyCacheKey = (county) => `county:${county}`;

async function getNycCountEstimates(jobKey) {
  const done = () => progress.completeUnit(jobKey, 'nycCounts', 'NYC volume counts ready');
  // Grouped aggregation — no countable total, so the bar leans on how long
  // this took last time.
  progress.beginUnit(jobKey, 'nycCounts', datasetCache.getTiming('nycCounts'));

  if (nycCountsCache && Date.now() - nycCountsCache.loadedAt < config.datasetCacheTtlMs) {
    done();
    return nycCountsCache;
  }

  const persisted = datasetCache.get(NYC_COUNTS_CACHE_KEY);
  if (persisted) {
    nycCountsCache = { estimates: persisted, loadedAt: Date.now() };
    done();
    return nycCountsCache;
  }

  const dailyRows = await nycCountsService.fetchRecentDailyTotals({
    onPage: ({ rowsSoFar }) =>
      progress.detail(jobKey, `NYC volume counts — ${rowsSoFar.toLocaleString()} daily totals`),
  });
  const estimates = nycCountsService.estimateAadtFromDailyTotals(dailyRows);
  nycCountsCache = { estimates, loadedAt: Date.now() };
  datasetCache.set(NYC_COUNTS_CACHE_KEY, estimates);
  done();
  return nycCountsCache;
}

async function getCountyStations(county, jobKey) {
  const done = () => progress.completeUnit(jobKey, countyCacheKey(county), `${county} loaded`);
  progress.beginUnit(jobKey, countyCacheKey(county), datasetCache.getTiming(countyCacheKey(county)));

  const cached = countyCache.get(county);
  if (cached && Date.now() - cached.loadedAt < config.datasetCacheTtlMs) {
    done();
    return cached.stations;
  }

  const persisted = datasetCache.get(countyCacheKey(county));
  if (persisted) {
    countyCache.set(county, { stations: persisted, loadedAt: Date.now() });
    done();
    return persisted;
  }

  // Ask how many rows this county has before paging, so the long fetch reports
  // a real fraction rather than sitting at 0% for most of a cold load. One
  // cheap aggregate against a query we're about to run anyway.
  const expectedRows = await aadtService.countCountyRows(county);
  const rows = await aadtService.fetchCountyRows(county, {
    onPage: ({ rowsSoFar }) => {
      const of = expectedRows ? ` of ${expectedRows.toLocaleString()}` : '';
      progress.detail(jobKey, `${county} AADT — ${rowsSoFar.toLocaleString()}${of} rows`);
      if (expectedRows) {
        progress.setUnitFraction(jobKey, countyCacheKey(county), rowsSoFar / expectedRows);
      }
    },
  });
  const stations = aadtService.buildStationTrends(rows);
  countyCache.set(county, { stations, loadedAt: Date.now() });
  datasetCache.set(countyCacheKey(county), stations);
  done();
  return stations;
}

/** Builds the fully-joined + scored segment list for a county. */
async function buildCountySegments(county, jobKey) {
  const stations = await getCountyStations(county, jobKey);
  const isNycCounty = NYC_COUNTIES.includes(county);

  let estimatesBySegmentDirection = new Map();
  let joinByStationId = new Map();
  // 511NY events for this county only. The feed is statewide and already
  // indexed by county, so each station is only distance-checked against its
  // own county's events — same scoping trick as the borough filter in
  // spatialJoin, and it keeps this an O(stations x county events) pass.
  let countyEvents = [];
  let eventFeedStatus = 'not-applicable-outside-nyc';
  if (isNycCounty) {
    const { estimates } = await getNycCountEstimates(jobKey);
    for (const e of estimates) {
      estimatesBySegmentDirection.set(`${e.segmentId}|${e.direction}`, e);
    }
    const joins = joinStationsToCounts(stations, estimates);
    for (const j of joins) joinByStationId.set(j.stationId, j);

    const eventIndex = await fiveElevenService.getNycEventIndex();
    countyEvents = eventIndex.byCounty.get(county) ?? [];
    eventFeedStatus = eventIndex.status;
    progress.completeUnit(jobKey, 'events', 'Live 511NY events matched');
  }

  return stations.map((station) => {
    const join = joinByStationId.get(station.stationId);
    const nycEstimate = join?.spatialMatch
      ? estimatesBySegmentDirection.get(`${join.spatialMatch.segmentId}|${join.spatialMatch.direction}`)
      : null;

    // Events can only be matched to a station we've managed to geocode — the
    // same precondition the count join has, so an ungeocoded station keeps
    // hasActiveConstruction as null ("not checked") rather than false.
    const stationLatLon = join?.stationLat != null ? { lat: join.stationLat, lon: join.stationLon } : null;
    const nearbyEvents =
      eventFeedStatus === 'ok' && stationLatLon
        ? fiveElevenService.findEventsNear(stationLatLon, countyEvents)
        : [];
    const { hasActiveConstruction, explainedBy } = fiveElevenService.explanationFor(nearbyEvents);
    const isEventCheckMeaningful = eventFeedStatus === 'ok' && stationLatLon != null;

    const deviation = computeDeviation({
      trend: station.trend,
      nycEstimate,
      hasActiveConstruction: isEventCheckMeaningful ? hasActiveConstruction : null,
      explainedBy,
    });

    return {
      stationId: station.stationId,
      // Link to NYSDOT's own dashboard for this station — the only public place
      // carrying current-year volume. Available for every county, including the
      // 57 outside NYC where no recent-count comparison is possible at all.
      officialDashboardUrl: siteDashboardUrl(station.stationId),
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
      liveEvents: {
        status: isEventCheckMeaningful
          ? 'ok'
          : eventFeedStatus === 'ok'
            ? 'station-not-located'
            : eventFeedStatus,
        // Capped for payload size — the full count is reported alongside so a
        // segment sitting inside a dense cluster of work zones still reads as
        // such in the UI.
        matchedCount: nearbyEvents.length,
        events: nearbyEvents.slice(0, 5),
      },
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

  // One unit per county, plus the two shared NYC steps (counts aggregation,
  // 511 events) when any NYC county is in scope, plus the final scoring pass.
  const isNycScope = counties.some((c) => NYC_COUNTIES.includes(c));
  const key = progress.jobKey(county);
  progress.start(key, counties.length + (isNycScope ? 2 : 0) + 1);

  try {
    const all = (await Promise.all(counties.map((c) => buildCountySegments(c, key)))).flat();
    return finalizeSegments(all, { ageThresholdYears, deviationThresholdPct, confidenceLevel, key });
  } finally {
    // Feed measured step durations back to disk so the next cold load's bar is
    // calibrated against this machine and connection, not a guess.
    for (const [unitId, ms] of Object.entries(progress.durations(key))) {
      datasetCache.setTiming(unitId, ms);
    }
    progress.finish(key);
  }
}

/** Filtering, sorting and the final scoring progress unit. */
function finalizeSegments(all, { ageThresholdYears, deviationThresholdPct, confidenceLevel, key }) {

  // Only surface segments that yield a real measured deviation. Without one a
  // row ranks on age alone (the 'age-only' priorityBasis in deviationEngine),
  // which is a much weaker claim than "this count is measurably out of date"
  // and shows as a blank deviation column.
  //
  // Scoped to counties where a recent NYC count is possible at all: the 57
  // non-NYC counties have no comparable source by definition, so applying this
  // there would empty those views entirely rather than filter them.
  let filtered = all.filter(
    (s) =>
      s.spatialMatchStatus === 'not-applicable-outside-nyc' ||
      (s.aadtRecentEstimate != null && s.deviationPct != null)
  );

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
  progress.completeUnit(key, 'scoring', 'Scored and ranked');
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
  // Segments whose deviation was set aside specifically because 511 reports a
  // work zone/closure on them — i.e. the ones the event feed actively pushed
  // down the list. Counted separately from low-confidence-trend "explained"
  // cases, which are a statement about our own data rather than the road.
  const explainedByLiveEvents = segments.filter(
    (s) => s.isExplained && s.liveEvents?.matchedCount > 0 && s.explanation?.startsWith('511NY:')
  );

  return {
    total,
    pctOlderThan5Years: Math.round((stale.length / total) * 1000) / 10,
    pctStaleWithSignificantUnexplainedDeviation:
      stale.length === 0 ? 0 : Math.round((staleWithSignificantUnexplained.length / stale.length) * 1000) / 10,
    explainedByLiveEventsCount: explainedByLiveEvents.length,
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
      // Explicit arrow: a bare `.map(getCountyStations)` would pass the array
      // index as the second argument, which is now the progress job key.
      const allNycStations = (await Promise.all(NYC_COUNTIES.map((c) => getCountyStations(c)))).flat();
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
  const stations = (await Promise.all(relevant.map((c) => getCountyStations(c)))).flat();
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
