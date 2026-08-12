const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeDeviation } = require('../server/services/deviationEngine');

const highConfidenceTrend = {
  trendConfidence: 'high',
  dataPointCount: 10,
  aadtExpectedCurrent: 10000,
  ageYears: 4,
  isLongExtrapolation: false,
};

test('significant unexplained deviation scores highest (age x |deviation%| x 1)', () => {
  const d = computeDeviation({
    trend: highConfidenceTrend,
    nycEstimate: { aadtRecentEstimate: 13000, observedDayCount: 10, isShortCountEstimate: false },
  });
  assert.equal(d.deviationPct, 30); // (13000-10000)/10000*100
  assert.equal(d.isDeviationSignificant, true);
  assert.equal(d.isExplained, false);
  assert.equal(d.priorityScore, 4 * 30 * 1);
});

test('deviation below threshold is not significant', () => {
  const d = computeDeviation({
    trend: highConfidenceTrend,
    nycEstimate: { aadtRecentEstimate: 10500, observedDayCount: 10, isShortCountEstimate: false },
    deviationThresholdPct: 17.5,
  });
  assert.equal(d.isDeviationSignificant, false);
});

test('low trend confidence is explained and de-weighted by 0.25x, but still flagged', () => {
  const shakyTrend = { trendConfidence: 'low', dataPointCount: 2, aadtExpectedCurrent: 10000, ageYears: 4 };
  const d = computeDeviation({
    trend: shakyTrend,
    nycEstimate: { aadtRecentEstimate: 13000, observedDayCount: 10, isShortCountEstimate: false },
  });
  assert.equal(d.isExplained, true);
  assert.equal(d.priorityScore, 4 * 30 * 0.25);
});

test('active construction/closure explains the deviation even with a high-confidence trend', () => {
  const d = computeDeviation({
    trend: highConfidenceTrend,
    nycEstimate: { aadtRecentEstimate: 13000, observedDayCount: 10, isShortCountEstimate: false },
    hasActiveConstruction: true,
  });
  assert.equal(d.isExplained, true);
  assert.equal(d.priorityScore, 4 * 30 * 0.25);
});

test('single-ever-count station is flagged as a refresh candidate regardless of deviation', () => {
  const singleTrend = { trendConfidence: 'none', dataPointCount: 1, aadtExpectedCurrent: 8000, ageYears: 9 };
  const d = computeDeviation({ trend: singleTrend, nycEstimate: null });
  assert.equal(d.isSingleEverCount, true);
  assert.equal(d.isExplained, true); // trend_confidence none => explained per spec
  assert.ok(d.priorityScore > 0, 'a single-count station must still rank, not score zero');
});

test('no comparable recent observation falls back to age-only priority basis, not null/NaN', () => {
  const d = computeDeviation({ trend: highConfidenceTrend, nycEstimate: null });
  assert.equal(d.deviationPct, null);
  assert.equal(d.isDeviationSignificant, null);
  assert.equal(d.priorityBasis, 'age-only (no comparable recent observation)');
  assert.ok(Number.isFinite(d.priorityScore));
});

test('confidence bundle always accompanies the deviation number', () => {
  const d = computeDeviation({
    trend: highConfidenceTrend,
    nycEstimate: { aadtRecentEstimate: 13000, observedDayCount: 2, isShortCountEstimate: true },
  });
  assert.equal(d.confidence.dataPointCount, 10);
  assert.equal(d.confidence.trendConfidence, 'high');
  assert.equal(d.confidence.isShortCountEstimate, true);
});
