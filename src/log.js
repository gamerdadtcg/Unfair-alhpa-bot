function log(message) {
  console.log(String(message).replace(/\s+/g, ' ').slice(0, 500));
}

function logError(label, err) {
  const status = err?.status ?? err?.response?.status ?? err?.code;
  const msg = err?.rawError?.message || err?.message || String(err);
  log(`${label}${status ? ` (${status})` : ''}: ${msg}`);
}

function logScore(candidate) {
  const s = candidate.score || {};
  log(
    `SCORE ${candidate.name} ${candidate.chain} total=${s.total} onchain=${s.onchain} social=${s.social} team=${s.team} timing=${s.timing} why=${candidate.why || ''}`
  );
}

module.exports = { log, logError, logScore };
