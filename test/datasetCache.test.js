const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isFresh, pruneExpired } = require('../server/services/datasetCache');

const TTL = 60 * 60 * 1000; // 1h, matching the datasetCacheTtlMs default
const NOW = 1_700_000_000_000;

test('an entry within the TTL is fresh', () => {
  assert.equal(isFresh({ loadedAt: NOW - 1000, value: [] }, NOW, TTL), true);
});

test('an entry past the TTL is not fresh', () => {
  assert.equal(isFresh({ loadedAt: NOW - TTL - 1, value: [] }, NOW, TTL), false);
});

test('missing or malformed entries are never treated as fresh', () => {
  assert.equal(isFresh(undefined, NOW, TTL), false);
  assert.equal(isFresh(null, NOW, TTL), false);
  assert.equal(isFresh({ value: [] }, NOW, TTL), false, 'no loadedAt');
  assert.equal(isFresh({ loadedAt: 'yesterday', value: [] }, NOW, TTL), false);
});

test('pruneExpired keeps fresh entries and drops stale ones', () => {
  const entries = {
    'county:Kings': { loadedAt: NOW - 1000, value: ['fresh'] },
    'county:Albany': { loadedAt: NOW - TTL - 1, value: ['stale'] },
    nycCounts: { loadedAt: NOW, value: ['fresh'] },
  };
  const kept = pruneExpired(entries, NOW, TTL);
  assert.deepEqual(Object.keys(kept).sort(), ['county:Kings', 'nycCounts']);
});

test('pruneExpired tolerates an absent entries object', () => {
  assert.deepEqual(pruneExpired(undefined, NOW, TTL), {});
  assert.deepEqual(pruneExpired(null, NOW, TTL), {});
});

test('pruning an all-stale cache yields an empty object, not a throw', () => {
  const entries = { a: { loadedAt: 0, value: [1] }, b: { loadedAt: 1, value: [2] } };
  assert.deepEqual(pruneExpired(entries, NOW, TTL), {});
});
