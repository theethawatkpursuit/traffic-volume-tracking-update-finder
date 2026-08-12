const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fitAadtTrend } = require('../server/utils/regression');

test('no readings -> trend_confidence none, nothing to project', () => {
  const t = fitAadtTrend([], 2026);
  assert.equal(t.trendConfidence, 'none');
  assert.equal(t.dataPointCount, 0);
  assert.equal(t.aadtExpectedCurrent, null);
});

test('single reading -> trend_confidence none, expected = that value (flag regardless of deviation)', () => {
  const t = fitAadtTrend([{ year: 2015, aadt: 10000 }], 2026);
  assert.equal(t.trendConfidence, 'none');
  assert.equal(t.dataPointCount, 1);
  assert.equal(t.aadtExpectedCurrent, 10000);
  assert.equal(t.ageYears, 11);
});

test('2-3 readings -> low-confidence two-point trend', () => {
  const t = fitAadtTrend(
    [
      { year: 2010, aadt: 10000 },
      { year: 2020, aadt: 12000 },
    ],
    2026
  );
  assert.equal(t.trendConfidence, 'low');
  assert.equal(t.dataPointCount, 2);
  // slope = 200/yr, projected to 2026: 12000 + 200*6 = 13200
  assert.equal(Math.round(t.aadtExpectedCurrent), 13200);
});

test('>=4 readings -> full OLS regression, high confidence within clean extrapolation window', () => {
  const points = [
    { year: 2016, aadt: 10000 },
    { year: 2017, aadt: 10500 },
    { year: 2018, aadt: 11000 },
    { year: 2019, aadt: 11500 },
  ];
  const t = fitAadtTrend(points, 2021, 7); // 2 years past last point, well inside window
  assert.equal(t.trendConfidence, 'high');
  assert.equal(t.dataPointCount, 4);
  assert.equal(Math.round(t.aadtExpectedCurrent), 12500); // slope 500/yr from 2019 -> 2021
  assert.equal(t.isLongExtrapolation, false);
});

test('projection far past last data point is flagged low-confidence', () => {
  const points = [
    { year: 2000, aadt: 10000 },
    { year: 2001, aadt: 10100 },
    { year: 2002, aadt: 10200 },
    { year: 2003, aadt: 10300 },
  ];
  const t = fitAadtTrend(points, 2026, 7); // 23 years past last point
  assert.equal(t.isLongExtrapolation, true);
  assert.equal(t.trendConfidence, 'low');
});

test('flat/duplicate readings produce a ~zero slope, not an error', () => {
  const points = [
    { year: 2015, aadt: 8000 },
    { year: 2016, aadt: 8000 },
    { year: 2017, aadt: 8000 },
    { year: 2018, aadt: 8000 },
  ];
  const t = fitAadtTrend(points, 2019, 7);
  assert.equal(Math.round(t.aadtExpectedCurrent), 8000);
});
