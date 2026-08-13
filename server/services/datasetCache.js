const fs = require('node:fs');
const config = require('../config');

/**
 * Disk-backed layer under the in-memory dataset caches in segmentsRepository.
 *
 * Without it, every process restart re-pages the ~290k-row Socrata AADT query
 * and the grouped NYC counts aggregation before the first request can be
 * answered — 30-90 seconds. That is tolerable once a day and painful under
 * `npm run dev`, where `node --watch` restarts on every server-file save.
 *
 * Same durability approach as geocodeService: write to a temp file and rename
 * over the target, so a crash mid-write can't leave a half-written cache
 * behind. Unlike the geocode cache this one is TTL-bound rather than
 * permanent — the underlying datasets do get republished, so entries older
 * than `datasetCacheTtlMs` are ignored on read and dropped on write.
 *
 * Every operation here is best-effort. A cache is an optimization, so a
 * missing, corrupt or unwritable file must degrade to "fetch it live", never
 * to a failed request.
 */

const CACHE_VERSION = 1;

let cache = null; // { version, entries: { [key]: { loadedAt, value } } }

/** True when an entry exists and hasn't aged past the TTL. */
function isFresh(entry, now = Date.now(), ttlMs = config.datasetCacheTtlMs) {
  return Boolean(entry) && typeof entry.loadedAt === 'number' && now - entry.loadedAt < ttlMs;
}

/** Drops expired entries — keeps the file from growing with stale counties forever. */
function pruneExpired(entries, now = Date.now(), ttlMs = config.datasetCacheTtlMs) {
  const kept = {};
  for (const [key, entry] of Object.entries(entries ?? {})) {
    if (isFresh(entry, now, ttlMs)) kept[key] = entry;
  }
  return kept;
}

function emptyCache() {
  return { version: CACHE_VERSION, entries: {}, timings: {} };
}

/**
 * Reads the build-time snapshot bundled with the deployment. Entries are
 * re-stamped as loaded now rather than keeping their build timestamp: the
 * snapshot is the freshest data this deployment has, so expiring it by TTL
 * would just force the very refetch it exists to avoid — and on a serverless
 * host that refetch is exactly what times out.
 */
function loadSnapshot() {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.datasetSnapshotPath, 'utf8'));
    if (parsed?.version !== CACHE_VERSION) return null;
    const now = Date.now();
    const entries = {};
    for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
      entries[key] = { loadedAt: now, value: entry.value };
    }
    const count = Object.keys(entries).length;
    if (count === 0) return null;
    console.log(`[dataset-cache] seeded from build snapshot (${count} entries)`);
    return { version: CACHE_VERSION, entries, timings: parsed.timings ?? {} };
  } catch {
    return null; // no snapshot built — fall back to fetching on demand
  }
}

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(config.datasetCachePath, 'utf8'));
    // A version bump means the cached shape may no longer match what the code
    // expects; discarding is always safe, since everything here is refetchable.
    cache = parsed?.version === CACHE_VERSION
      ? {
          version: CACHE_VERSION,
          entries: pruneExpired(parsed.entries),
          // Timings are how long each load step took last time, used to drive
          // the progress bar. They describe our own past behaviour rather than
          // upstream data, so they aren't TTL'd away with the cached payloads —
          // an expired county's timing is still the best estimate we have.
          timings: parsed.timings ?? {},
        }
      : emptyCache();
  } catch {
    cache = emptyCache(); // missing or corrupt — start clean
  }

  // Nothing usable from the writable cache? Fall back to the bundled snapshot.
  // This is the normal path on a fresh deploy and the only path on a
  // serverless host, where the writable directory is ephemeral and empty.
  if (Object.keys(cache.entries).length === 0) {
    const snapshot = loadSnapshot();
    if (snapshot) cache = snapshot;
  }
  return cache;
}

function save() {
  const current = load();
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmpPath = `${config.datasetCachePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(current), 'utf8');
    fs.renameSync(tmpPath, config.datasetCachePath); // atomic swap
  } catch (err) {
    // Disk full, read-only checkout, permissions — none of which should stop
    // the app serving data it already has in memory.
    console.warn('[dataset-cache] could not persist:', err.message);
  }
}

/** Cached value for `key`, or null when absent or expired. */
function get(key) {
  const entry = load().entries[key];
  return isFresh(entry) ? entry.value : null;
}

/** Stores `value` under `key` and persists immediately. */
function set(key, value) {
  const current = load();
  current.entries[key] = { loadedAt: Date.now(), value };
  current.entries = pruneExpired(current.entries);
  save();
}

/** Milliseconds a load step took last time, or null if never recorded. */
function getTiming(unitId) {
  const ms = load().timings[unitId];
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Records how long a step took. Smoothed against the previous value so one
 * unusually slow run (a Socrata retry, say) doesn't skew every later estimate.
 */
function setTiming(unitId, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const current = load();
  const previous = current.timings[unitId];
  current.timings[unitId] = Number.isFinite(previous) ? Math.round(previous * 0.6 + ms * 0.4) : ms;
  save();
}

/** Testing/diagnostics: forget the in-memory copy so the next read hits disk. */
function reset() {
  cache = null;
}

function stats() {
  const entries = load().entries;
  return { keys: Object.keys(entries), count: Object.keys(entries).length };
}

module.exports = {
  isFresh, pruneExpired, get, set, getTiming, setTiming, load, save, reset, stats, CACHE_VERSION,
};
