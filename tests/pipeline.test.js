const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ALPHA_STORE_PATH = path.join(os.tmpdir(), `alpha-pipe-${process.pid}.json`);
fs.writeFileSync(process.env.ALPHA_STORE_PATH, JSON.stringify({ items: {}, blacklistDeployers: [] }));

const { runPipeline } = require('../src/pipeline');

test('mock pipeline lists Glass Gardens + Hood Signals, rejects farm', async () => {
  const result = await runPipeline({ mock: true, applyPostedDedupe: true, persist: false });
  const names = result.items.map(c => c.name);
  assert.ok(names.includes('Glass Gardens'));
  assert.ok(names.includes('Hood Signals'));
  assert.ok(!names.includes('AI Ape Pixel Punks'));
  assert.match(result.digest.text, /GM ALPHA/);
  assert.match(result.digest.text, /2 mints worth looking at/);
  assert.doesNotMatch(result.digest.text, /Already posted this morning/);
  assert.doesNotMatch(result.digest.text, /AI Ape/);
});
