const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { firstWritableDir } = require('../server/utils/dataDir');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'datadir-test-'));

test('returns the first candidate when it is writable', () => {
  const first = path.join(scratch, 'first');
  const second = path.join(scratch, 'second');
  assert.equal(firstWritableDir([first, second]), first);
  assert.equal(fs.existsSync(first), true, 'the chosen directory should be created');
});

test('skips a candidate whose path is occupied by a file', () => {
  // Stands in for the read-only project directory on a serverless host: the
  // candidate can't be created, so resolution must fall through rather than
  // throw at import time and take every request down with it.
  const blocked = path.join(scratch, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  const fallback = path.join(scratch, 'fallback');

  assert.equal(firstWritableDir([blocked, fallback]), fallback);
});

test('skips empty/undefined candidates, as when DATA_DIR is unset', () => {
  const target = path.join(scratch, 'target');
  assert.equal(firstWritableDir([undefined, '', null, target]), target);
});

test('returns null when nothing in the chain is usable', () => {
  const blockedA = path.join(scratch, 'blockedA');
  const blockedB = path.join(scratch, 'blockedB');
  fs.writeFileSync(blockedA, 'file');
  fs.writeFileSync(blockedB, 'file');
  assert.equal(firstWritableDir([blockedA, blockedB]), null);
});

test('an empty candidate list yields null rather than throwing', () => {
  assert.equal(firstWritableDir([]), null);
});

test('nested paths are created recursively', () => {
  const deep = path.join(scratch, 'a', 'b', 'c');
  assert.equal(firstWritableDir([deep]), deep);
  assert.equal(fs.existsSync(deep), true);
});
