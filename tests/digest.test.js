const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatDigest } = require('../src/digest');
const { scoreCandidate } = require('../src/scorer');
const good = require('../src/fixtures/goodMint.json');

test('empty digest does not invent projects', () => {
  const d = formatDigest([]);
  assert.match(d.text, /No high-quality new mints cleared filters today/);
  assert.doesNotMatch(d.text, /Glass Gardens/);
});

test('digest is a single ranked list in trader voice', () => {
  const scored = scoreCandidate(good);
  const d = formatDigest([scored], { date: new Date('2026-08-30T14:00:00Z') });
  assert.match(d.text, /GM ALPHA/);
  assert.match(d.text, /ETH \+ ROBINHOOD/);
  assert.match(d.text, /Glass Gardens/);
  assert.match(d.text, /Chain: ETH/);
  assert.match(d.text, /Why:/);
  assert.match(d.text, /Contract:/);
  assert.doesNotMatch(d.text, /\*\*/);
});
