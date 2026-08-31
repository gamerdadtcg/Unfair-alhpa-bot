const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreCandidate, pickList } = require('../src/scorer');
const good = require('../src/fixtures/goodMint.json');
const farm = require('../src/fixtures/farmMint.json');
const rh = require('../src/fixtures/goodMintRh.json');

test('good mint scores at or above 60', () => {
  const scored = scoreCandidate(good);
  assert.ok(scored.score.total >= 60, `score was ${scored.score.total}`);
  assert.ok(scored.score.onchain <= 35);
  assert.ok(scored.score.social <= 30);
  assert.ok(scored.score.team <= 20);
  assert.ok(scored.score.timing <= 15);
});

test('farm mint scores below the quality bar', () => {
  const scored = scoreCandidate(farm);
  assert.ok(scored.score.total < 60, `farm score ${scored.score.total} should be junk`);
});

test('pickList caps at 8 and does not pad junk', () => {
  const farmScored = scoreCandidate(farm);
  const picked = pickList([scoreCandidate(good), farmScored, scoreCandidate(rh)]);
  assert.ok(picked.every(c => c.score.total >= 50));
  assert.ok(!picked.some(c => c.slug === 'ai-ape-pixel-punks'));
  assert.ok(picked.length <= 8);
});
