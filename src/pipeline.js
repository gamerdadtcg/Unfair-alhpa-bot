const { LIST_CAP } = require('./config');
const { log, logScore } = require('./log');
const { collectOpenSea } = require('./collectors/opensea');
const { collectEthMints } = require('./collectors/ethMints');
const { collectRhMints } = require('./collectors/rhMints');
const { enrichAll } = require('./enrich');
const { hardReject, shouldSkipAsRepeat } = require('./filters');
const { scoreCandidate, pickList } = require('./scorer');
const { markPosted, markRejected } = require('./store');
const { formatDigest } = require('./digest');
const { loadMockCandidates } = require('./fixtures/load');

function mergeCandidates(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const c of list || []) {
      const addr = String(c.contractAddress || '').toLowerCase();
      const key = addr && addr.startsWith('0x') ? `${c.chain}:${addr}` : `${c.chain}:slug:${c.slug}`;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, c);
        continue;
      }
      map.set(key, {
        ...prev,
        ...c,
        url: c.url || prev.url,
        twitterUrl: c.twitterUrl || prev.twitterUrl,
        siteUrl: c.siteUrl || prev.siteUrl,
        stages: (c.stages || []).length >= (prev.stages || []).length ? c.stages : prev.stages,
        uniqueMinters: c.uniqueMinters ?? prev.uniqueMinters,
        uniqueHolders: c.uniqueHolders ?? prev.uniqueHolders,
        verified: c.verified ?? prev.verified,
        source: `${prev.source}+${c.source}`
      });
    }
  }
  return [...map.values()];
}

async function collectLive() {
  const settled = await Promise.allSettled([
    collectOpenSea(),
    collectEthMints(),
    collectRhMints()
  ]);
  const lists = settled.map((r, i) => {
    const name = ['opensea', 'eth', 'rh'][i];
    if (r.status === 'rejected') {
      log(`${name} collector failed: ${r.reason?.message || r.reason}`);
      return [];
    }
    log(`${name} collector returned ${r.value.length}`);
    return r.value;
  });
  return mergeCandidates(lists);
}

function runFiltersAndScore(candidates, { applyPostedDedupe = true, persist = true } = {}) {
  const kept = [];
  for (const raw of candidates) {
    const reason = hardReject(raw);
    if (reason) {
      if (persist) markRejected(raw, reason);
      log(`REJECT ${raw.name || raw.slug}: ${reason}`);
      continue;
    }
    const scored = scoreCandidate(raw);
    logScore(scored);
    if (applyPostedDedupe) {
      const repeat = shouldSkipAsRepeat(scored);
      if (repeat) {
        if (persist) markRejected(scored, repeat);
        log(`SKIP ${scored.name}: ${repeat}`);
        continue;
      }
    }
    kept.push(scored);
  }
  return pickList(kept).slice(0, LIST_CAP);
}

async function runPipeline({ mock = false, applyPostedDedupe = true, persist = true } = {}) {
  const raw = mock ? mergeCandidates([loadMockCandidates()]) : await collectLive();
  const enriched = mock ? raw : await enrichAll(raw);
  const picked = runFiltersAndScore(enriched, { applyPostedDedupe, persist });
  const digest = formatDigest(picked);
  return { items: picked, digest, scanned: enriched.length };
}

async function runAndPersist(opts) {
  const result = await runPipeline({ ...opts, persist: true });
  if (!opts?.dry && result.items.length) markPosted(result.items);
  return result;
}

module.exports = { runPipeline, runAndPersist, mergeCandidates, runFiltersAndScore };
