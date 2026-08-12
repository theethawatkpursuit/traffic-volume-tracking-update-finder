const { haversineDistanceMeters } = require('../utils/geo');
const { getCachedGeocode } = require('./geocodeService');
const config = require('../config');

// NYSDOT AADT uses county names; the NYC counts dataset uses borough names.
// Same five places, different labels — used to scope the nearest-neighbor
// search to the same borough/county (cuts wasted distance checks and rules
// out spurious cross-borough matches).
const COUNTY_TO_BOROUGH = {
  Bronx: 'Bronx',
  Kings: 'Brooklyn',
  'New York': 'Manhattan',
  Queens: 'Queens',
  Richmond: 'Staten Island',
};

/**
 * Finds the nearest NYC automated-count location (by great-circle distance)
 * to a geocoded AADT station, constrained to the matching borough and a
 * radius cutoff. Pure function — no I/O — so it's directly testable.
 */
function findNearestCount(stationLatLon, nycCountIndex, { radiusMeters, borough } = {}) {
  let best = null;
  for (const count of nycCountIndex) {
    if (count.lat == null || count.lon == null) continue;
    if (borough && count.borough && count.borough !== borough) continue;
    const distanceMeters = haversineDistanceMeters(
      stationLatLon.lat,
      stationLatLon.lon,
      count.lat,
      count.lon
    );
    if (distanceMeters <= radiusMeters && (!best || distanceMeters < best.distanceMeters)) {
      best = { ...count, distanceMeters };
    }
  }
  return best;
}

/**
 * Joins AADT stations to NYC automated-count locations by geographic
 * proximity (not by ID — the two sources share no key). Stations are
 * geocoded ahead of time (see geocodeService); this step only reads that
 * cache, so it never blocks on network I/O.
 */
function joinStationsToCounts(stations, nycCountIndex, { radiusMeters = config.spatialJoinRadiusMeters } = {}) {
  return stations.map((station) => {
    const geocode = getCachedGeocode(station);
    if (!geocode || geocode.lat == null) {
      return {
        stationId: station.stationId,
        spatialMatch: null,
        spatialMatchStatus: geocode ? 'geocode-failed' : 'geocode-pending',
      };
    }

    const borough = COUNTY_TO_BOROUGH[station.county];
    const match = findNearestCount(geocode, nycCountIndex, { radiusMeters, borough });

    return {
      stationId: station.stationId,
      stationLat: geocode.lat,
      stationLon: geocode.lon,
      geocodeConfidence: geocode.confidence,
      spatialMatch: match
        ? {
            segmentId: match.segmentId,
            direction: match.direction,
            street: match.street,
            fromSt: match.fromSt,
            toSt: match.toSt,
            distanceMeters: Math.round(match.distanceMeters),
          }
        : null,
      spatialMatchStatus: match ? 'matched' : 'no-match-within-radius',
    };
  });
}

module.exports = { COUNTY_TO_BOROUGH, findNearestCount, joinStationsToCounts };
