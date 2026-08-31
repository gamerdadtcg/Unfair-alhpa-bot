const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeGroup } = require('../src/collectors/mintLogs');

test('summarizeGroup splits unique minters into 1h / 6h / 24h', () => {
  const now = Date.now();
  const g = {
    address: '0xabc',
    firstMintAt: now - 20 * 36e5,
    events: [
      { to: '0x1', ts: now - 10 * 60 * 1000 },
      { to: '0x2', ts: now - 10 * 60 * 1000 },
      { to: '0x3', ts: now - 3 * 36e5 },
      { to: '0x1', ts: now - 3 * 36e5 },
      { to: '0x4', ts: now - 12 * 36e5 },
      { to: '0x5', ts: now - 12 * 36e5 }
    ]
  };
  const s = summarizeGroup(g, now);
  assert.equal(s.minters1h, 2);
  assert.equal(s.minters6h, 3);
  assert.equal(s.minters24h, 5);
  assert.equal(s.uniqueMinters, 5);
  assert.equal(s.count, 6);
});
