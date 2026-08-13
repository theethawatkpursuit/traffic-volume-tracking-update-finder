const { test } = require('node:test');
const assert = require('node:assert/strict');
const progress = require('../server/services/progressTracker');

function freshJob(total = 4, key = `test-${Math.random()}`) {
  progress.start(key, total);
  return key;
}

test('progress starts at zero and reports the declared total', () => {
  const key = freshJob(4);
  const p = progress.get(key);
  assert.equal(p.pct, 0);
  assert.equal(p.completed, 0);
  assert.equal(p.total, 4);
  assert.equal(p.done, false);
});

test('each completed unit advances the bar proportionally', () => {
  const key = freshJob(4);
  progress.completeUnit(key, 'county:Kings', 'Kings loaded');
  assert.equal(progress.get(key).pct, 25);
  progress.completeUnit(key, 'nycCounts');
  assert.equal(progress.get(key).pct, 50);
});

test('completing the same unit twice does not double-count', () => {
  const key = freshJob(4);
  progress.completeUnit(key, 'county:Kings');
  progress.completeUnit(key, 'county:Kings');
  progress.completeUnit(key, 'county:Kings');
  assert.equal(progress.get(key).completed, 1);
  assert.equal(progress.get(key).pct, 25);
});

test('a row-count fraction moves the bar within a single unit', () => {
  const key = freshJob(4);
  progress.setUnitFraction(key, 'county:Kings', 0.5);
  assert.equal(progress.get(key).pct, 13); // half of one unit out of four
  progress.setUnitFraction(key, 'county:Kings', 1);
  assert.equal(progress.get(key).pct, 25);
});

test('a fraction is superseded, not added to, when its unit completes', () => {
  const key = freshJob(4);
  progress.setUnitFraction(key, 'county:Kings', 0.9);
  progress.completeUnit(key, 'county:Kings');
  assert.equal(progress.get(key).pct, 25, 'must not read as 0.9 + 1 units');
});

test('fractions are clamped to the 0..1 range', () => {
  const key = freshJob(4);
  progress.setUnitFraction(key, 'a', 5);
  assert.equal(progress.get(key).pct, 25);
  progress.setUnitFraction(key, 'b', -3);
  assert.equal(progress.get(key).pct, 25);
});

test('an elapsed-time estimate never credits a unit as fully done', () => {
  const key = freshJob(1);
  progress.beginUnit(key, 'slow', 10); // already past its 10ms estimate
  const p = progress.get(key);
  assert.ok(p.pct <= 95, `time-based estimate should stay under 100, got ${p.pct}`);
  assert.equal(p.done, false);
});

test('a real row count takes precedence over the time estimate', () => {
  const key = freshJob(1);
  progress.beginUnit(key, 'unit', 1); // time estimate would say ~95%
  progress.setUnitFraction(key, 'unit', 0.2);
  assert.equal(progress.get(key).pct, 20);
});

test('the bar never exceeds 99% before the job is actually finished', () => {
  const key = freshJob(2);
  progress.completeUnit(key, 'one');
  progress.setUnitFraction(key, 'two', 1);
  assert.ok(progress.get(key).pct <= 99);
});

test('finishing reports 100% and records measured durations', () => {
  const key = freshJob(2);
  progress.beginUnit(key, 'one', null);
  progress.completeUnit(key, 'one');
  assert.ok(Number.isFinite(progress.durations(key).one), 'duration should be recorded');
  progress.finish(key);
  const p = progress.get(key);
  assert.equal(p.pct, 100);
  assert.equal(p.done, true);
});

test('polling an unknown scope returns null rather than throwing', () => {
  assert.equal(progress.get('no-such-job'), null);
  // Reporting into a job that was never started must be a safe no-op — the
  // detail view calls the same builders without a progress key.
  assert.doesNotThrow(() => {
    progress.completeUnit(undefined, 'x');
    progress.setUnitFraction(undefined, 'x', 0.5);
    progress.detail(undefined, 'y');
    progress.beginUnit(undefined, 'x', 100);
  });
});

test('jobKey distinguishes a single county from the all-boroughs default', () => {
  assert.equal(progress.jobKey('Kings'), 'county:Kings');
  assert.equal(progress.jobKey(undefined), 'all-nyc');
  assert.notEqual(progress.jobKey('Kings'), progress.jobKey(undefined));
});
