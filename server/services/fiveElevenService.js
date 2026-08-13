const axios = require('axios');
const config = require('../config');
const { haversineDistanceMeters } = require('../utils/geo');

/**
 * 511NY event feed (GetEvents) — the "is there a known cause here?" source.
 *
 * Unlike TomTom (speed/congestion at one point, queried on demand per opened
 * segment), this feed is a single statewide bulk call that returns every
 * active event at once, so it can be fetched once, cached, and applied to
 * *every* segment in the list. That's what makes it usable as the
 * `hasActiveConstruction` input to the priority formula rather than a
 * display-only panel: an unexplained deviation and a deviation sitting on top
 * of a known long-term construction zone no longer rank the same.
 *
 * 511NY county names match the NYSDOT AADT dataset's `county` field exactly
 * (Bronx / Kings / New York / Queens / Richmond) — no borough translation
 * needed, unlike the NYC counts dataset (see spatialJoin.COUNTY_TO_BOROUGH).
 */

const NYC_COUNTY_NAMES = ['Bronx', 'Kings', 'New York', 'Queens', 'Richmond'];

// Which event types actually *explain* a change in traffic volume. Roadwork,
// closures and incidents physically divert or block traffic past a counting
// location; `specialEvents` (concerts, parades) and `transitOperations` (bus
// stop bypasses) are shown as context in the UI but deliberately do NOT
// de-weight a segment's priority — a one-evening ballgame is not a reason to
// stop trusting a multi-year AADT baseline.
const EXPLANATORY_EVENT_TYPES = new Set(['roadwork', 'closures', 'accidentsAndIncidents']);

// Ranking for picking which nearby event to name as *the* explanation.
const EVENT_TYPE_RANK = { closures: 0, accidentsAndIncidents: 1, roadwork: 2 };

let eventCache = null; // { byCounty: Map<county, event[]>, count, status, fetchedAt }

/**
 * 511NY serializes timestamps as **DD/MM/YYYY HH:mm:ss**, not the US MM/DD
 * order the descriptions themselves use. Verified against the live feed:
 * 1508 of ~2400 `StartDate` values have a leading component > 12 and *none*
 * have a second component > 12, so the leading number is unambiguously the
 * day. Passing these straight to `new Date()` parses them as MM/DD and
 * silently shifts events by months (e.g. "09/07/2026" would read as
 * 7 September instead of 9 July), which would wreck the active-now filter.
 * Parsed in server-local time; 511NY publishes in Eastern, which is what a
 * NYC DOT deployment runs in.
 */
function parse511Date(value) {
  if (!value || typeof value !== 'string') return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return null;
  const [, day, month, year, hh, mm, ss] = m;
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hh ?? 0),
    Number(mm ?? 0),
    Number(ss ?? 0)
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Maps one raw 511NY event record into the shape the rest of the app uses. */
function normalizeEvent(raw) {
  const lat = Number(raw.Latitude);
  const lon = Number(raw.Longitude);
  const startDate = parse511Date(raw.StartDate);
  const plannedEndDate = parse511Date(raw.PlannedEndDate);

  return {
    id: raw.ID,
    county: raw.CountyName,
    roadway: raw.RoadwayName,
    direction: raw.DirectionOfTravel,
    description: raw.Description,
    eventType: raw.EventType,
    eventSubType: raw.EventSubType,
    severity: raw.Severity,
    lanesAffected: raw.LanesAffected && raw.LanesAffected !== 'No Data' ? raw.LanesAffected : null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    startDate: startDate ? startDate.toISOString() : null,
    plannedEndDate: plannedEndDate ? plannedEndDate.toISOString() : null,
    // Most of this feed carries no planned end date ("until further notice").
    // Surfaced rather than hidden: an open-ended event that started two years
    // ago is a weaker explanation than one with a live end date, and the
    // planner should be able to see that distinction.
    isOpenEnded: !plannedEndDate,
    isExplanatory: EXPLANATORY_EVENT_TYPES.has(raw.EventType),
  };
}

/**
 * An event counts as active if it has started and hasn't passed its planned
 * end. Open-ended events (no PlannedEndDate) are treated as ongoing — that's
 * how 511NY represents long-term construction, which is exactly the case that
 * most legitimately explains a depressed count.
 */
function isEventActive(event, now = new Date()) {
  const t = now.getTime();
  if (event.startDate && new Date(event.startDate).getTime() > t) return false;
  if (event.plannedEndDate && new Date(event.plannedEndDate).getTime() < t) return false;
  return true;
}

/**
 * Nearest-events lookup around a geocoded AADT station. Pure function — no
 * I/O — so it's directly testable, mirroring spatialJoin.findNearestCount.
 * Returns every event in range (not just the closest): a planner wants to see
 * that a segment sits inside three overlapping work zones, not just one.
 */
function findEventsNear(stationLatLon, events, { radiusMeters = config.eventMatchRadiusMeters } = {}) {
  if (!stationLatLon || stationLatLon.lat == null) return [];
  const hits = [];
  for (const event of events) {
    if (event.lat == null || event.lon == null) continue;
    const distanceMeters = haversineDistanceMeters(
      stationLatLon.lat,
      stationLatLon.lon,
      event.lat,
      event.lon
    );
    if (distanceMeters <= radiusMeters) {
      hits.push({ ...event, distanceMeters: Math.round(distanceMeters) });
    }
  }
  return hits.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/**
 * Collapses the events near one station into the single boolean the priority
 * formula takes, plus a human-readable reason for the UI. Closures outrank
 * incidents outrank roadwork; ties break on proximity.
 */
function explanationFor(nearbyEvents) {
  const explanatory = nearbyEvents.filter((e) => e.isExplanatory);
  if (explanatory.length === 0) {
    return { hasActiveConstruction: false, explainedBy: null, explainingEvent: null };
  }
  const best = [...explanatory].sort((a, b) => {
    const rank = (EVENT_TYPE_RANK[a.eventType] ?? 9) - (EVENT_TYPE_RANK[b.eventType] ?? 9);
    return rank !== 0 ? rank : a.distanceMeters - b.distanceMeters;
  })[0];

  const label = best.eventSubType || best.eventType;
  return {
    hasActiveConstruction: true,
    explainedBy: `511NY: ${label} on ${best.roadway || 'nearby road'} (${best.distanceMeters}m)`,
    explainingEvent: best,
  };
}

/**
 * Fetches the statewide event feed and indexes the NYC-county subset by
 * county. Fails soft: a 511 outage returns an `unavailable` status rather
 * than throwing, so the segments list still renders (with
 * `hasActiveConstruction` left as null = "not checked" rather than false =
 * "checked, nothing there").
 */
async function getNycEventIndex({ now = new Date() } = {}) {
  if (eventCache && Date.now() - eventCache.fetchedAt < config.eventsCacheTtlMs) {
    return eventCache;
  }

  try {
    const { data } = await axios.get(`${config.fiveEleven.baseUrl}/getevents`, {
      timeout: config.apiTimeoutMs,
      params: { key: config.fiveEleven.apiKey, format: 'json' },
    });

    const raw = Array.isArray(data) ? data : [];
    const byCounty = new Map(NYC_COUNTY_NAMES.map((c) => [c, []]));
    let count = 0;

    for (const record of raw) {
      if (!byCounty.has(record.CountyName)) continue; // statewide feed, NYC-only scope
      const event = normalizeEvent(record);
      if (event.lat == null || !isEventActive(event, now)) continue;
      byCounty.get(event.county).push(event);
      count += 1;
    }

    eventCache = {
      byCounty,
      count,
      totalStatewide: raw.length,
      status: 'ok',
      fetchedAt: Date.now(),
    };
    return eventCache;
  } catch (err) {
    // Cache the failure briefly too, so a 511 outage doesn't mean a fresh
    // failing request on every single segment list load.
    eventCache = {
      byCounty: new Map(NYC_COUNTY_NAMES.map((c) => [c, []])),
      count: 0,
      status: 'unavailable',
      message: err.response?.status ? `HTTP ${err.response.status}` : err.message,
      fetchedAt: Date.now(),
    };
    return eventCache;
  }
}

module.exports = {
  NYC_COUNTY_NAMES,
  EXPLANATORY_EVENT_TYPES,
  parse511Date,
  normalizeEvent,
  isEventActive,
  findEventsNear,
  explanationFor,
  getNycEventIndex,
};
