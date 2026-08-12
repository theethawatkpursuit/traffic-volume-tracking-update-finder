const config = require('../config');

/**
 * The analytical core: turns a station's fitted trend + (optional) matched
 * recent NYC estimate + (optional) live construction/closure context into a
 * deviation figure and a priority_score, per the spec's explicit formula.
 * Pure function — no I/O — so it's directly testable.
 *
 * @param {object} trend - output of utils/regression.fitAadtTrend
 * @param {object|null} nycEstimate - output of nycCountsService.estimateAadtFromDailyTotals (one entry)
 * @param {boolean|null} hasActiveConstruction - from TomTom context; null when not checked (list view — TomTom is on-demand only)
 * @param {number} deviationThresholdPct
 */
function computeDeviation({
  trend,
  nycEstimate = null,
  hasActiveConstruction = null,
  deviationThresholdPct = config.deviationThresholdPct,
}) {
  const isLowConfidenceTrend = trend.trendConfidence === 'low' || trend.trendConfidence === 'none';
  const isSingleEverCount = trend.trendConfidence === 'none' && trend.dataPointCount === 1;

  const hasDeviationSignal =
    nycEstimate != null &&
    trend.aadtExpectedCurrent != null &&
    trend.aadtExpectedCurrent > 0;

  let deviationPct = null;
  let isDeviationSignificant = null;
  let priorityBasis;

  if (hasDeviationSignal) {
    deviationPct =
      ((nycEstimate.aadtRecentEstimate - trend.aadtExpectedCurrent) / trend.aadtExpectedCurrent) * 100;
    isDeviationSignificant = Math.abs(deviationPct) > deviationThresholdPct;
    priorityBasis = 'age × |deviation%|';
  } else {
    // No comparable recent observation (no spatial match, or the segment's
    // trend has nothing to project). Rather than silently scoring these as
    // zero-priority (which would bury exactly the segments with the least
    // data), treat them as "at the significance threshold" so age still
    // drives ranking, but visibly flag the basis so it's never confused
    // with a real measured deviation.
    priorityBasis = 'age-only (no comparable recent observation)';
  }

  // Explained = active construction/closure OR the trend itself is
  // low/no-confidence (a shaky baseline shouldn't be read as a "surprise").
  const isExplained = hasActiveConstruction === true || isLowConfidenceTrend;

  const ageYears = trend.ageYears ?? 0;
  const deviationMagnitudeForScore = hasDeviationSignal
    ? Math.abs(deviationPct)
    : deviationThresholdPct;
  const priorityScore = ageYears * deviationMagnitudeForScore * (isExplained ? 0.25 : 1);

  return {
    aadtExpectedCurrent: trend.aadtExpectedCurrent,
    aadtRecentEstimate: nycEstimate?.aadtRecentEstimate ?? null,
    deviationPct,
    isDeviationSignificant,
    isExplained,
    isSingleEverCount,
    priorityScore,
    priorityBasis,
    confidence: {
      dataPointCount: trend.dataPointCount,
      trendConfidence: trend.trendConfidence,
      lastDataYear: trend.lastDataYear,
      ageYears: trend.ageYears,
      isLongExtrapolation: trend.isLongExtrapolation,
      nycEstimateWindowDays: nycEstimate?.observedDayCount ?? null,
      isShortCountEstimate: nycEstimate?.isShortCountEstimate ?? null,
    },
  };
}

module.exports = { computeDeviation };
