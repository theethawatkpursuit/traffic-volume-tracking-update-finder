const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parse511Date,
  normalizeEvent,
  isEventActive,
  findEventsNear,
  explanationFor,
} = require('../server/services/fiveElevenService');

// Fixture captured from a live GetEvents response during development —
// a real Manhattan long-term construction closure on NY 9A.
const RAW_NY9A_CLOSURE = {
  ID: 'TRANSCOM-ORI1238148801',
  CountyName: 'New York',
  RoadwayName: 'NY 9A',
  DirectionOfTravel: 'Northbound',
  Description: 'Construction on NY 9A northbound ramp to W 125th Street (New York) All lanes closed for Long Term Construction',
  EventType: 'closures',
  EventSubType: 'roadwork',
  Severity: 'Minor',
  LanesAffected: 'No Data',
  Latitude: 40.818447,
  Longitude: -73.961052,
  StartDate: '12/03/2026 06:34:17',
  PlannedEndDate: '',
};

test('511 dates parse as DD/MM/YYYY, not the US MM/DD order', () => {
  // The single most dangerous field in this feed: `new Date('09/07/2026')`
  // yields 7 September, but 511NY means 9 July. Verified against the live
  // feed, where 1508 StartDate values have a leading component > 12.
  const d = parse511Date('09/07/2026 10:56:48');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 6, 'expected July (month index 6), not September');
  assert.equal(d.getDate(), 9);
  assert.equal(d.getHours(), 10);
});

test('parse511Date handles a day component that could not be a month', () => {
  const d = parse511Date('25/12/2025 00:00:00');
  assert.equal(d.getMonth(), 11);
  assert.equal(d.getDate(), 25);
});

test('parse511Date returns null for the feed\'s empty/missing dates rather than Invalid Date', () => {
  assert.equal(parse511Date(''), null);
  assert.equal(parse511Date(null), null);
  assert.equal(parse511Date('not a date'), null);
});

test('an empty PlannedEndDate is normalized as open-ended, not as an expired event', () => {
  const e = normalizeEvent(RAW_NY9A_CLOSURE);
  assert.equal(e.plannedEndDate, null);
  assert.equal(e.isOpenEnded, true);
  assert.equal(e.isExplanatory, true);
  assert.equal(e.lanesAffected, null, "'No Data' should not surface as a lane description");
});

test('open-ended events that have already started count as active', () => {
  const e = normalizeEvent(RAW_NY9A_CLOSURE);
  assert.equal(isEventActive(e, new Date('2026-08-13T12:00:00')), true);
});

test('events that have not started yet, or are past their planned end, are inactive', () => {
  const future = normalizeEvent({ ...RAW_NY9A_CLOSURE, StartDate: '01/12/2026 00:00:00' }); // 1 Dec 2026
  assert.equal(isEventActive(future, new Date('2026-08-13T12:00:00')), false);

  const finished = normalizeEvent({
    ...RAW_NY9A_CLOSURE,
    StartDate: '01/01/2026 00:00:00',
    PlannedEndDate: '01/02/2026 00:00:00', // 1 Feb 2026
  });
  assert.equal(isEventActive(finished, new Date('2026-08-13T12:00:00')), false);
});

test('findEventsNear respects the radius and returns nearest-first', () => {
  const station = { lat: 40.818447, lon: -73.961052 };
  const near = { ...normalizeEvent(RAW_NY9A_CLOSURE), lat: 40.8188, lon: -73.9612 }; // ~40m
  const mid = { ...normalizeEvent(RAW_NY9A_CLOSURE), id: 'mid', lat: 40.8207, lon: -73.9615 }; // ~250m
  const far = { ...normalizeEvent(RAW_NY9A_CLOSURE), id: 'far', lat: 40.86, lon: -73.99 }; // km away

  const hits = findEventsNear(station, [far, mid, near], { radiusMeters: 400 });
  assert.equal(hits.length, 2, 'the kilometres-away event must be excluded');
  assert.equal(hits[0].id, RAW_NY9A_CLOSURE.ID, 'nearest should sort first');
  assert.ok(hits[0].distanceMeters < hits[1].distanceMeters);
});

test('an ungeocoded station yields no events rather than throwing', () => {
  assert.deepEqual(findEventsNear(null, [normalizeEvent(RAW_NY9A_CLOSURE)]), []);
  assert.deepEqual(findEventsNear({ lat: null, lon: null }, [normalizeEvent(RAW_NY9A_CLOSURE)]), []);
});

test('special events and transit notices are shown but do NOT explain away a deviation', () => {
  const concert = normalizeEvent({
    ...RAW_NY9A_CLOSURE,
    ID: 'concert',
    EventType: 'specialEvents',
    EventSubType: 'Concert',
  });
  const transit = normalizeEvent({
    ...RAW_NY9A_CLOSURE,
    ID: 'transit',
    EventType: 'transitOperations',
    EventSubType: 'roadwork',
  });
  assert.equal(concert.isExplanatory, false);
  assert.equal(transit.isExplanatory, false);

  const result = explanationFor([
    { ...concert, distanceMeters: 10 },
    { ...transit, distanceMeters: 20 },
  ]);
  assert.equal(result.hasActiveConstruction, false, 'a ballgame is not a reason to distrust an AADT baseline');
  assert.equal(result.explainedBy, null);
});

test('a closure outranks roadwork as the named explanation, even when further away', () => {
  const roadwork = { ...normalizeEvent({ ...RAW_NY9A_CLOSURE, ID: 'rw', EventType: 'roadwork', EventSubType: 'Milling' }), distanceMeters: 30 };
  const closure = { ...normalizeEvent(RAW_NY9A_CLOSURE), distanceMeters: 300 };

  const result = explanationFor([roadwork, closure]);
  assert.equal(result.hasActiveConstruction, true);
  assert.equal(result.explainingEvent.eventType, 'closures');
  assert.match(result.explainedBy, /^511NY: /);
  assert.match(result.explainedBy, /300m/);
});

test('no nearby events means the deviation stays unexplained', () => {
  const result = explanationFor([]);
  assert.equal(result.hasActiveConstruction, false);
  assert.equal(result.explainedBy, null);
});
