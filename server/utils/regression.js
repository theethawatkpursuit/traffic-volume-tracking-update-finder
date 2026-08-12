/**
 * Fits a trend to a station's historical AADT readings and projects it to
 * the current year. Pure/testable — no I/O.
 *
 * @param {Array<{year: number, aadt: number}>} points - one point per
 *   distinct year (caller should already have deduped/averaged same-year
 *   readings).
 * @param {number} currentYear
 * @param {number} maxCleanExtrapolationYears - beyond this many years past
 *   the last real data point, the projection is flagged low-confidence.
 */
function fitAadtTrend(points, currentYear, maxCleanExtrapolationYears = 7) {
  const sorted = [...points].sort((a, b) => a.year - b.year);
  const n = sorted.length;

  if (n === 0) {
    return {
      trendConfidence: 'none',
      dataPointCount: 0,
      aadtExpectedCurrent: null,
      lastDataYear: null,
      ageYears: null,
      isLongExtrapolation: null,
      slope: null,
      intercept: null,
    };
  }

  const lastDataYear = sorted[n - 1].year;
  const ageYears = currentYear - lastDataYear;
  const isLongExtrapolation = ageYears > maxCleanExtrapolationYears;

  if (n === 1) {
    return {
      trendConfidence: 'none',
      dataPointCount: 1,
      aadtExpectedCurrent: sorted[0].aadt,
      lastDataYear,
      ageYears,
      isLongExtrapolation,
      slope: null,
      intercept: null,
    };
  }

  if (n <= 3) {
    // Simple two-point trend using the first and last observations.
    const first = sorted[0];
    const last = sorted[n - 1];
    const slope = last.year === first.year ? 0 : (last.aadt - first.aadt) / (last.year - first.year);
    const intercept = last.aadt - slope * last.year;
    return {
      trendConfidence: 'low',
      dataPointCount: n,
      aadtExpectedCurrent: Math.max(0, slope * currentYear + intercept),
      lastDataYear,
      ageYears,
      isLongExtrapolation,
      slope,
      intercept,
    };
  }

  // n >= 4: full ordinary-least-squares linear regression, year vs AADT.
  const meanX = sorted.reduce((s, p) => s + p.year, 0) / n;
  const meanY = sorted.reduce((s, p) => s + p.aadt, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of sorted) {
    num += (p.year - meanX) * (p.aadt - meanY);
    den += (p.year - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;

  return {
    trendConfidence: isLongExtrapolation ? 'low' : 'high',
    dataPointCount: n,
    aadtExpectedCurrent: Math.max(0, slope * currentYear + intercept),
    lastDataYear,
    ageYears,
    isLongExtrapolation,
    slope,
    intercept,
  };
}

module.exports = { fitAadtTrend };
