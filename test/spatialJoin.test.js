const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findNearestCount } = require('../server/services/spatialJoin');

// Fixture: real AADT station 22102 (Kingston Ave @ Empire Blvd, Kings
// county) geocoded via Nominatim, and the real NYC automated-count segment
// 42961 (Kingston Ave between Lefferts Ave and Empire Blvd, Brooklyn) with
// its wktgeom converted to lat/lon — both captured from live API responses
// during development. This is the "validate against a handful of known
// segments" step the spatial join spec calls for: the geocode landed ~650m
// from the true station (falling back to a road-only query rather than the
// cross-street-specific one), which is why the default radius is 400m+ and
// every match reports its real distance rather than a boolean.
const GEOCODED_KINGSTON_AVE_STATION = { lat: 40.6694074, lon: -73.9421829 };
const NYC_KINGSTON_AVE_COUNT = {
  segmentId: '42961',
  direction: 'NB',
  street: 'KINGSTON AVENUE',
  fromSt: 'Lefferts Avenue',
  toSt: 'Empire Boulevard',
  borough: 'Brooklyn',
  lat: 40.66355869598274,
  lon: -73.94275081240453,
};

// Decoys on other, unrelated Brooklyn avenues — far enough that a correct
// implementation must not prefer them over the true match once it's in range.
const DECOY_COUNTS = [
  { segmentId: '99001', direction: 'NB', street: 'FLATBUSH AVENUE', borough: 'Brooklyn', lat: 40.68, lon: -73.98 },
  { segmentId: '99002', direction: 'SB', street: 'OCEAN AVENUE', borough: 'Brooklyn', lat: 40.6, lon: -73.95 },
];

test('finds the real Kingston Ave match within radius, distance matches the validated ~650m', () => {
  const result = findNearestCount(GEOCODED_KINGSTON_AVE_STATION, [NYC_KINGSTON_AVE_COUNT, ...DECOY_COUNTS], {
    radiusMeters: 700,
    borough: 'Brooklyn',
  });
  assert.ok(result, 'expected a match within 700m');
  assert.equal(result.segmentId, '42961');
  assert.ok(result.distanceMeters > 600 && result.distanceMeters < 700, `distance out of expected range: ${result.distanceMeters}`);
});

test('respects the radius cutoff — same station, tighter radius yields no match', () => {
  const result = findNearestCount(GEOCODED_KINGSTON_AVE_STATION, [NYC_KINGSTON_AVE_COUNT, ...DECOY_COUNTS], {
    radiusMeters: 200,
    borough: 'Brooklyn',
  });
  assert.equal(result, null);
});

test('borough scoping excludes same-distance-or-closer matches in the wrong borough', () => {
  const wrongBoroughCount = { ...NYC_KINGSTON_AVE_COUNT, segmentId: '77777', borough: 'Queens' };
  const result = findNearestCount(GEOCODED_KINGSTON_AVE_STATION, [wrongBoroughCount], {
    radiusMeters: 700,
    borough: 'Brooklyn',
  });
  assert.equal(result, null);
});

test('picks the nearest of several in-range candidates, not just the first', () => {
  const closer = { ...NYC_KINGSTON_AVE_COUNT, segmentId: 'closer', lat: 40.6695, lon: -73.9422 };
  const result = findNearestCount(GEOCODED_KINGSTON_AVE_STATION, [NYC_KINGSTON_AVE_COUNT, closer], {
    radiusMeters: 700,
    borough: 'Brooklyn',
  });
  assert.equal(result.segmentId, 'closer');
});
