const axios = require('axios');
const config = require('../config');

// Small in-memory TTL cache so repeatedly opening the same segment's detail
// view within a session doesn't re-hit TomTom every time. This is per-segment
// on-demand querying only — never a bulk pull.
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map(); // key: "lat,lon" (rounded) -> { data, expiresAt }

function cacheKey(lat, lon) {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

/**
 * Live traffic flow (speed/congestion) at a single coordinate.
 * TomTom Traffic Flow Segment Data API — key is a query param, not a header.
 */
async function getFlowSegmentData(lat, lon, { zoom = 12 } = {}) {
  const key = cacheKey(lat, lon);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const url = `${config.tomtom.baseUrl}/traffic/services/4/flowSegmentData/absolute/${zoom}/json`;
  try {
    const { data } = await axios.get(url, {
      timeout: config.apiTimeoutMs,
      params: {
        key: config.tomtom.apiKey,
        point: `${lat},${lon}`,
      },
    });

    const seg = data.flowSegmentData;
    const result = seg
      ? {
          currentSpeed: seg.currentSpeed,
          freeFlowSpeed: seg.freeFlowSpeed,
          currentTravelTime: seg.currentTravelTime,
          freeFlowTravelTime: seg.freeFlowTravelTime,
          confidence: seg.confidence,
          roadClosure: seg.roadClosure,
          congestionRatio:
            seg.freeFlowSpeed > 0 ? 1 - seg.currentSpeed / seg.freeFlowSpeed : null,
          fetchedAt: new Date().toISOString(),
        }
      : null;

    cache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    return {
      error: true,
      message: err.response?.data?.error ?? err.message,
      fetchedAt: new Date().toISOString(),
    };
  }
}

module.exports = { getFlowSegmentData };
