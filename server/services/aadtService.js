const { SocrataClient } = require('./socrata');
const config = require('../config');
const { fitAadtTrend } = require('../utils/regression');

const client = new SocrataClient(config.openNy);

const FIELDS =
  'aadt_year, station_id, county, signing, state_route, county_road, road_name, ' +
  'beginning_description, ending_description, municipality, length, fc, ramp, bridge, rr_xing, oneway, count';

/** Fetches every raw AADT row for one county. */
async function fetchCountyRows(county) {
  const rows = await client.queryAll({
    select: FIELDS,
    where: `county='${county.replace(/'/g, "''")}'`,
    order: 'station_id, aadt_year',
  });
  return rows;
}

/**
 * Groups raw AADT rows by station_id, dedupes same-year readings (NYSDOT
 * carries forward/interpolates AADT between physical counts, so duplicate
 * years for a station are averaged rather than treated as independent
 * samples), and fits the historical trend for each station.
 */
function buildStationTrends(rows, currentYear = config.currentYear) {
  const byStation = new Map();
  for (const r of rows) {
    if (!byStation.has(r.station_id)) {
      byStation.set(r.station_id, {
        stationId: r.station_id,
        county: r.county,
        signing: r.signing,
        stateRoute: r.state_route,
        countyRoad: r.county_road,
        roadName: r.road_name,
        beginningDescription: r.beginning_description,
        endingDescription: r.ending_description,
        municipality: r.municipality,
        readings: [],
      });
    }
    const aadt = Number(r.count);
    const year = Number(r.aadt_year);
    if (Number.isFinite(aadt) && Number.isFinite(year)) {
      byStation.get(r.station_id).readings.push({ year, aadt });
    }
  }

  const stations = [];
  for (const station of byStation.values()) {
    const byYear = new Map();
    for (const { year, aadt } of station.readings) {
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(aadt);
    }
    const yearlyPoints = [...byYear.entries()].map(([year, values]) => ({
      year,
      aadt: values.reduce((s, v) => s + v, 0) / values.length,
    }));

    const trend = fitAadtTrend(yearlyPoints, currentYear, config.maxCleanExtrapolationYears);
    stations.push({
      ...station,
      readings: undefined,
      history: yearlyPoints.sort((a, b) => a.year - b.year),
      trend,
    });
  }
  return stations;
}

module.exports = { fetchCountyRows, buildStationTrends, FIELDS };
