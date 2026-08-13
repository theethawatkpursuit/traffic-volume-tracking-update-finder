const fs = require('node:fs');

/**
 * Picks the first candidate directory that can actually be created and written
 * to. Extracted from config so the fallback chain is unit-testable without
 * needing a genuinely read-only filesystem to hand.
 *
 * Probing by attempting the write is deliberate: `fs.accessSync` alone reports
 * the permission bits, which on a read-only mount or a container with a
 * dropped capability can disagree with what a write actually does. Creating
 * the directory is the same operation the caches will perform later, so if it
 * succeeds here it will succeed for them.
 */
function firstWritableDir(candidates) {
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // Not usable — a read-only filesystem, a missing parent we may not
      // create, or a path already occupied by a file. Try the next candidate.
    }
  }
  return null;
}

module.exports = { firstWritableDir };
