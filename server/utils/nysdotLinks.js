const config = require('../config');

/**
 * Deep links into NYSDOT's official Site Dashboard (a Drakewell-hosted system,
 * separate from the ArcGIS services this app reads).
 *
 * That dashboard carries current-year AADT trend, average hourly volume and
 * daily volume for a station — data that is several years newer than anything
 * NYSDOT publishes through an open API. It is deliberately not machine
 * readable (reCAPTCHA Enterprise plus `Disallow: /` in robots.txt), so this
 * app does not fetch it. Handing the planner a direct link instead keeps the
 * authoritative current numbers one click away without automating access to a
 * system that asks not to be automated.
 *
 * The dashboard's `cosit` parameter is the station number zero-padded to six
 * digits followed by six zeros — verified against a real station:
 *
 *   cosit 054255000000 -> RCStation "054255" -> RCSTA 54255
 *                      -> 77TH ST @ 31ST AVE, Queens
 *
 * which is the same identifier this app already carries as `stationId` from
 * the NYSDOT AADT dataset.
 */

const COSIT_STATION_DIGITS = 6;
const COSIT_SUFFIX = '000000';

/** Converts an AADT `station_id` into the dashboard's cosit, or null if it can't be one. */
function stationIdToCosit(stationId) {
  if (stationId == null) return null;
  const digits = String(stationId).trim();
  // Station ids are numeric and at most six digits; anything else isn't a
  // NYSDOT station number and would produce a link to nowhere.
  if (!/^\d{1,6}$/.test(digits)) return null;
  return digits.padStart(COSIT_STATION_DIGITS, '0') + COSIT_SUFFIX;
}

/**
 * Full Site Dashboard URL for a station, or null when the station id can't be
 * expressed as a cosit. Returns a link that is *probably* valid — every id in
 * the AADT dataset is an NYSDOT station number, but whether that station is
 * published on the dashboard can't be checked from here, so the UI presents
 * this as "open the official dashboard", not "here is the current AADT".
 */
function siteDashboardUrl(stationId) {
  const cosit = stationIdToCosit(stationId);
  if (!cosit) return null;
  const params = new URLSearchParams({ node: config.nysdotDashboard.node, cosit });
  return `${config.nysdotDashboard.baseUrl}/sitedashboard.asp?${params.toString()}`;
}

module.exports = { stationIdToCosit, siteDashboardUrl };
