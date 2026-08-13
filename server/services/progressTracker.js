/**
 * Tracks real progress of an in-flight /api/segments load so the UI can show a
 * bar that reflects work actually completed rather than an animation on a
 * timer.
 *
 * Progress is counted in **named units** rather than sequential phases,
 * because a multi-county load runs the counties concurrently (Promise.all) and
 * the shared steps — the NYC counts aggregation, the 511 event fetch — are
 * triggered by whichever county gets there first. Completing a unit is
 * idempotent and order-independent, so concurrency can't push the bar past
 * 100% or double-count a cached step.
 *
 * A percentage needs a denominator known up front, which rules out counting
 * Socrata pages (the row count isn't known until paging ends). Units are the
 * things we *do* know: one per county, plus the shared steps. Live row counts
 * are still reported as a sub-label, so the bar stays honest during the long
 * single-unit fetches instead of appearing stuck.
 */

const jobs = new Map(); // key -> { total, completed:Set<string>, label, detail, startedAt, done }

/** Scope key shared by the client and server so a poll finds the right job. */
function jobKey(county) {
  return county ? `county:${county}` : 'all-nyc';
}

function start(key, total) {
  jobs.set(key, {
    total: Math.max(1, total),
    completed: new Set(),
    partials: new Map(), // unitId -> 0..1, from a real row count
    inflight: new Map(), // unitId -> { startedAt, expectedMs }
    durations: {}, // unitId -> ms, fed back into the cache to sharpen next run
    label: 'Starting…',
    detail: null,
    startedAt: Date.now(),
    done: false,
  });
}

/**
 * Marks a unit as started, optionally with how long it took last time.
 * That estimate drives the bar for steps whose real size can't be known in
 * advance — chiefly the NYC counts aggregation, which is a grouped query with
 * no countable total and is the single slowest step in a cold load.
 */
function beginUnit(key, unitId, expectedMs = null) {
  const job = jobs.get(key);
  if (!job || job.completed.has(unitId) || job.inflight.has(unitId)) return;
  job.inflight.set(unitId, { startedAt: Date.now(), expectedMs });
}

/** Marks a named unit finished. Safe to call repeatedly for the same unit. */
function completeUnit(key, unitId, label) {
  const job = jobs.get(key);
  if (!job || job.completed.has(unitId)) return;
  const started = job.inflight.get(unitId);
  if (started) job.durations[unitId] = Date.now() - started.startedAt;
  job.completed.add(unitId);
  job.partials.delete(unitId); // fully counted now; don't double-count
  job.inflight.delete(unitId);
  if (label) job.label = label;
  job.detail = null; // the sub-label belonged to the unit that just finished
}

/** Measured durations, so the caller can persist them for the next run. */
function durations(key) {
  return jobs.get(key)?.durations ?? {};
}

/**
 * Fractional progress within a single in-flight unit, 0..1.
 *
 * Needed because the units are nowhere near equal in cost: a county's AADT
 * paging is ~75% of a cold load's wall time but only one unit of four, so
 * without this the bar sat at 0% for thirty seconds and then jumped. The
 * fraction comes from a real row count queried before paging starts, not an
 * estimate.
 */
function setUnitFraction(key, unitId, fraction) {
  const job = jobs.get(key);
  if (!job || job.completed.has(unitId)) return;
  job.partials.set(unitId, Math.min(1, Math.max(0, fraction)));
}

/** Live sub-label for the unit in flight, e.g. row counts as pages stream in. */
function detail(key, text) {
  const job = jobs.get(key);
  if (job) job.detail = text;
}

function finish(key) {
  const job = jobs.get(key);
  if (!job) return;
  job.done = true;
  job.label = 'Done';
  job.detail = null;
  // Keep the finished job around briefly so a poll already in flight resolves
  // to a clean 100% rather than a 404-shaped "no job" response.
  setTimeout(() => jobs.delete(key), 5000).unref?.();
}

/**
 * Fractional credit for one in-flight unit. A real row count always wins; the
 * elapsed-vs-expected estimate is the fallback for steps that can't report
 * one. The estimate is capped below 1 so a slower-than-usual run never shows a
 * unit as finished before it actually is.
 */
function fractionFor(job, unitId) {
  if (job.partials.has(unitId)) return job.partials.get(unitId);
  const started = job.inflight.get(unitId);
  if (started?.expectedMs) {
    return Math.min(0.95, (Date.now() - started.startedAt) / started.expectedMs);
  }
  return 0;
}

/** Completed units plus any fractional credit for the unit(s) in flight. */
function effectiveProgress(job) {
  let partial = 0;
  const seen = new Set();
  for (const unitId of job.partials.keys()) { partial += fractionFor(job, unitId); seen.add(unitId); }
  for (const unitId of job.inflight.keys()) if (!seen.has(unitId)) partial += fractionFor(job, unitId);
  return job.completed.size + partial;
}

function get(key) {
  const job = jobs.get(key);
  if (!job) return null;
  return {
    completed: job.completed.size,
    total: job.total,
    pct: job.done ? 100 : Math.min(99, Math.round((effectiveProgress(job) / job.total) * 100)),
    label: job.label,
    detail: job.detail,
    done: job.done,
    elapsedMs: Date.now() - job.startedAt,
  };
}

module.exports = {
  jobKey, start, beginUnit, completeUnit, setUnitFraction, detail, finish, get,
  durations, effectiveProgress, fractionFor,
};
