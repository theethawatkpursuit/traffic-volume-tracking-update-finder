const { test } = require('node:test');
const assert = require('node:assert/strict');
const { haversineDistanceMeters, wktGeomToLatLon, parseWktPoint } = require('../server/utils/geo');

test('haversine distance between identical points is 0', () => {
  assert.equal(haversineDistanceMeters(40.7, -73.9, 40.7, -73.9), 0);
});

test('haversine distance roughly matches a known NYC reference (Times Sq -> Metropolitan Museum, ~3.0km)', () => {
  const d = haversineDistanceMeters(40.758, -73.9855, 40.7812, -73.9665);
  assert.ok(d > 2800 && d < 3300, `expected ~3.0km, got ${d}m`);
});

test('parseWktPoint extracts x/y from a Socrata WKT POINT string', () => {
  const p = parseWktPoint('POINT (1035363.4 185093.4)');
  assert.deepEqual(p, { x: 1035363.4, y: 185093.4 });
});

test('parseWktPoint returns null for missing/malformed input', () => {
  assert.equal(parseWktPoint(null), null);
  assert.equal(parseWktPoint('not a point'), null);
});

test('wktGeomToLatLon converts a real NYC dataset point (Sutter Ave/Rockaway Blvd, Queens) into plausible lat/lon', () => {
  const { lat, lon } = wktGeomToLatLon('POINT (1035363.4 185093.4)');
  // South Ozone Park, Queens — roughly 40.67N, -73.82W.
  assert.ok(lat > 40.6 && lat < 40.75, `lat out of range: ${lat}`);
  assert.ok(lon > -73.9 && lon < -73.75, `lon out of range: ${lon}`);
});
