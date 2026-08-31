const fs = require('fs');
const path = require('path');
const { DEDUPE_DAYS } = require('./config');

const STORE_FILE =
  process.env.ALPHA_STORE_PATH || path.join(__dirname, '..', 'data', 'store.json');

function emptyStore() {
  return { items: {}, blacklistDeployers: [] };
}

function loadStore() {
  try {
    return { ...emptyStore(), ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
  } catch {
    return emptyStore();
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function keyOf(candidate) {
  const addr = String(candidate.contractAddress || '').toLowerCase();
  if (addr && addr.startsWith('0x')) return `${candidate.chain}:${addr}`;
  return `${candidate.chain}:slug:${String(candidate.slug || '').toLowerCase()}`;
}

function record(candidate, extra = {}) {
  const store = loadStore();
  const key = extra.key || keyOf(candidate);
  const prev = store.items[key] || {};
  store.items[key] = {
    contractAddress: candidate.contractAddress || null,
    chain: candidate.chain,
    slug: candidate.slug || null,
    first_seen_at: prev.first_seen_at || new Date().toISOString(),
    last_posted_at: extra.last_posted_at ?? prev.last_posted_at ?? null,
    last_score: extra.score ?? candidate.score?.total ?? prev.last_score ?? null,
    last_stage: extra.stage ?? candidate.activeStageKey ?? prev.last_stage ?? null,
    reason_rejected: extra.reason_rejected ?? prev.reason_rejected ?? null,
    name: candidate.name || prev.name || null
  };
  saveStore(store);
  return store.items[key];
}

function markPosted(candidates) {
  const now = new Date().toISOString();
  for (const c of candidates) {
    record(c, { last_posted_at: now, score: c.score?.total, stage: c.activeStageKey });
  }
}

function markRejected(candidate, reason) {
  record(candidate, { reason_rejected: reason, score: candidate.score?.total });
}

function getItem(candidate) {
  return loadStore().items[keyOf(candidate)] || null;
}

function postedWithinDays(candidate, days = DEDUPE_DAYS) {
  const item = getItem(candidate);
  if (!item?.last_posted_at) return false;
  const ageMs = Date.now() - new Date(item.last_posted_at).getTime();
  return ageMs < days * 24 * 60 * 60 * 1000;
}

function hoursSincePosted(candidate) {
  const item = getItem(candidate);
  if (!item?.last_posted_at) return Infinity;
  return (Date.now() - new Date(item.last_posted_at).getTime()) / 36e5;
}

function previousScore(candidate) {
  const item = getItem(candidate);
  return Number(item?.last_score || 0);
}

function previousStage(candidate) {
  return getItem(candidate)?.last_stage || null;
}

function isBlacklistedDeployer(address) {
  if (!address) return false;
  const store = loadStore();
  const file = path.join(__dirname, '..', 'data', 'blacklist.json');
  let extra = [];
  try {
    extra = JSON.parse(fs.readFileSync(file, 'utf8')).deployers || [];
  } catch {
    extra = [];
  }
  const all = [...(store.blacklistDeployers || []), ...extra].map(a => String(a).toLowerCase());
  return all.includes(String(address).toLowerCase());
}

module.exports = {
  loadStore,
  saveStore,
  keyOf,
  record,
  markPosted,
  markRejected,
  getItem,
  postedWithinDays,
  hoursSincePosted,
  previousScore,
  previousStage,
  isBlacklistedDeployer
};
