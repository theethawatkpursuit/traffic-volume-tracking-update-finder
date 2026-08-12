const proj4 = require('proj4');

// NY State Plane, Long Island zone, US survey feet (EPSG:2263) — the CRS the
// NYC traffic-volume dataset's wktgeom column is encoded in.
const NY_STATE_PLANE_2263 =
  '+proj=lcc +lat_1=40.66666666666666 +lat_2=41.03333333333333 +lat_0=40.16666666666666 ' +
  '+lon_0=-74 +x_0=300000.0000000001 +y_0=0 +ellps=GRS80 +datum=NAD83 +to_meter=0.3048006096012192 +no_defs';
const WGS84 = 'EPSG:4326';

const EARTH_RADIUS_METERS = 6371000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/long points, in meters. */
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/** Parses a Socrata WKT "POINT (x y)" string into { x, y } in its native CRS. */
function parseWktPoint(wkt) {
  if (!wkt) return null;
  const match = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(wkt);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** Converts an NY State Plane (EPSG:2263, feet) x/y pair to WGS84 lat/long. */
function statePlaneToLatLon(x, y) {
  const [lon, lat] = proj4(NY_STATE_PLANE_2263, WGS84, [x, y]);
  return { lat, lon };
}

/** Parses a NYC dataset wktgeom string directly to WGS84 { lat, lon }. */
function wktGeomToLatLon(wkt) {
  const point = parseWktPoint(wkt);
  if (!point) return null;
  return statePlaneToLatLon(point.x, point.y);
}

module.exports = {
  haversineDistanceMeters,
  parseWktPoint,
  statePlaneToLatLon,
  wktGeomToLatLon,
};
