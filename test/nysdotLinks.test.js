const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stationIdToCosit, siteDashboardUrl } = require('../server/utils/nysdotLinks');

// Ground truth: a real NYSDOT Site Dashboard URL, cross-checked against the
// ArcGIS AADT layer. cosit 054255000000 resolves to RCSTA 54255 —
// 77TH ST @ 31ST AVE, Queens — which is the same identifier this app carries
// as `stationId` from the Socrata AADT dataset.
test('a known real cosit is reproduced exactly from its station id', () => {
  assert.equal(stationIdToCosit('54255'), '054255000000');
});

test('station ids are padded to six digits, not left bare', () => {
  assert.equal(stationIdToCosit('20005'), '020005000000');
  assert.equal(stationIdToCosit('1285'), '001285000000');
  assert.equal(stationIdToCosit(14), '000014000000');
});

test('an already six-digit station id is not over-padded', () => {
  assert.equal(stationIdToCosit('123456'), '123456000000');
});

test('non-station identifiers yield null rather than a link to nowhere', () => {
  assert.equal(stationIdToCosit(null), null);
  assert.equal(stationIdToCosit(''), null);
  assert.equal(stationIdToCosit('1234567'), null, 'too long to be a station number');
  assert.equal(stationIdToCosit('20005A'), null);
  assert.equal(stationIdToCosit('not-a-station'), null);
});

test('the built URL matches the real dashboard link format', () => {
  assert.equal(
    siteDashboardUrl('54255'),
    'https://nysdottrafficdata.drakewell.com/sitedashboard.asp?node=NYSDOT_SC&cosit=054255000000'
  );
});

test('an unlinkable station produces no URL, so the UI can omit the button', () => {
  assert.equal(siteDashboardUrl('bogus'), null);
  assert.equal(siteDashboardUrl(null), null);
});
