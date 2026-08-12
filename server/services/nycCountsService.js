const { SocrataClient } = require('./socrata');
const config = require('../config');
const { wktGeomToLatLon } = require('../utils/geo');

const client = new SocrataClient(config.nycOpenData);

/**
 * Fetches NYC automated traffic-volume counts, aggregated server-side (via
 * SoQL $group) into one row per segment/direction/day — sums the 15-minute
 * `vol` readings into a daily total. Keeps the payload small: querying the
 * raw hourly/15-min rows for the lookback window would be ~270k rows;
 * grouped, it's a few thousand.
 */
async function fetchRecentDailyTotals({ sinceYear } = {}) {
  const since = sinceYear ?? config.currentYear - config.nycCountsLookbackYears;
  const fields = 'segmentid, direction, yr, m, d, street, fromst, tost, boro, wktgeom';
  const rows = await client.queryAll({
    select: `${fields}, sum(vol) as daily_vol`,
    where: `yr >= ${since}`,
    order: 'segmentid, direction, yr, m, d',
    group: fields,
  });

  return rows.map((r) => ({
    segmentId: r.segmentid,
    direction: r.direction,
    date: `${r.yr}-${String(r.m).padStart(2, '0')}-${String(r.d).padStart(2, '0')}`,
    dailyVolume: Number(r.daily_vol),
    street: r.street,
    fromSt: r.fromst,
    toSt: r.tost,
    borough: r.boro,
    wktgeom: r.wktgeom,
  }));
}

/**
 * Groups daily totals by segment+direction into a "short-count estimate":
 * average daily volume across the observed days, annualization-agnostic
 * (AADT is itself an average-daily-traffic figure, so a plain average of
 * observed daily totals is the comparable estimate).
 */
function estimateAadtFromDailyTotals(dailyRows) {
  const groups = new Map(); // key: segmentId|direction
  for (const row of dailyRows) {
    const key = `${row.segmentId}|${row.direction}`;
    if (!groups.has(key)) {
      groups.set(key, {
        segmentId: row.segmentId,
        direction: row.direction,
        street: row.street,
        fromSt: row.fromSt,
        toSt: row.toSt,
        borough: row.borough,
        wktgeom: row.wktgeom,
        dailyTotals: [],
      });
    }
    groups.get(key).dailyTotals.push({ date: row.date, volume: row.dailyVolume });
  }

  const estimates = [];
  for (const g of groups.values()) {
    const days = g.dailyTotals;
    const observedDayCount = days.length;
    const aadtRecentEstimate =
      days.reduce((sum, d) => sum + d.volume, 0) / Math.max(1, observedDayCount);
    const location = wktGeomToLatLon(g.wktgeom);
    estimates.push({
      segmentId: g.segmentId,
      direction: g.direction,
      street: g.street,
      fromSt: g.fromSt,
      toSt: g.toSt,
      borough: g.borough,
      lat: location?.lat ?? null,
      lon: location?.lon ?? null,
      observedDayCount,
      isShortCountEstimate: observedDayCount < config.shortCountWindowDays,
      aadtRecentEstimate,
      observationWindow: { first: days[0]?.date, last: days[days.length - 1]?.date },
    });
  }
  return estimates;
}

module.exports = { fetchRecentDailyTotals, estimateAadtFromDailyTotals };
