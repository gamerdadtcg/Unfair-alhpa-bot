const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `alpha-store-${process.pid}.json`);
process.env.ALPHA_STORE_PATH = tmp;
fs.writeFileSync(tmp, JSON.stringify({ items: {}, blacklistDeployers: [] }));

const { hardReject, shouldSkipAsRepeat } = require('../src/filters');
const { markPosted } = require('../src/store');
const farm = require('../src/fixtures/farmMint.json');
const good = require('../src/fixtures/goodMint.json');
const repeat = require('../src/fixtures/repeatMint.json');

test('farm mint is hard-rejected', () => {
  const reason = hardReject(farm);
  assert.ok(reason, 'expected a reject reason');
  assert.match(reason, /farm|spam|social|wallet|deployer|metadata/i);
});

test('good mint clears hard filters', () => {
  assert.equal(hardReject(good), null);
});

test('repeat mint is skipped after being posted', () => {
  assert.equal(hardReject(repeat), null);
  markPosted([{ ...repeat, score: { total: 70 }, activeStageKey: 'Public' }]);
  const scored = { ...repeat, score: { total: 71 }, activeStageKey: 'Public' };
  assert.equal(shouldSkipAsRepeat(scored), 'already posted in last 7 days');
});

test('missing contract is rejected', () => {
  assert.equal(hardReject({ ...good, contractAddress: null }), 'no contract address');
});
