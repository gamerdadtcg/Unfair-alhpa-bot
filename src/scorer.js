const { hoursUntil } = require('./filters');

function clamp(n, max) {
  return Math.max(0, Math.min(max, n));
}

function scoreOnchain(c) {
  let pts = 0;
  const m1 = c.minters1h || 0;
  const m6 = c.minters6h || 0;
  const m24 = c.minters24h || c.uniqueMinters || 0;
  if (m1 >= 8) pts += 8;
  else if (m1 >= 3) pts += 5;
  else if (m1 >= 1) pts += 2;

  if (m6 >= 20) pts += 8;
  else if (m6 >= 8) pts += 5;
  else if (m6 >= 3) pts += 2;

  if (m24 >= 40) pts += 6;
  else if (m24 >= 12) pts += 4;
  else if (m24 >= 5) pts += 2;

  if (c.uniqueHolders != null && c.totalSupply) {
    const ratio = c.uniqueHolders / Math.max(1, c.totalSupply);
    if (ratio >= 0.6) pts += 5;
    else if (ratio >= 0.35) pts += 3;
    else if (ratio >= 0.15) pts += 1;
  }

  if (c.verified === true) pts += 5;
  if (c.hasRoyalty) pts += 3;
  return clamp(pts, 35);
}

function scoreSocial(c) {
  let pts = 0;
  if (c.twitterUrl) pts += 10;
  if (c.siteUrl) {
    const cheap = /carrd\.co|linktr\.ee|bio\.link/i.test(c.siteUrl);
    pts += cheap ? 3 : 8;
  }
  if (c.discordUrl) pts += 3;
  if (c.url && /opensea\.io/i.test(c.url)) pts += 4;
  const stages = c.stages || [];
  if (stages.length >= 2) pts += 5;
  else if (stages.length === 1 && (stages[0].label || stages[0].stage_type)) pts += 3;
  if (c.maxSupply) pts += 2;
  return clamp(pts, 30);
}

function scoreTeam(c) {
  let pts = 12;
  const name = String(c.name || '').toLowerCase();
  if (/\b(ape|punk|azuki|pudgy|doodle|clone|copy|pass)\b/.test(name)) pts -= 6;
  if (c.looksFactory) pts -= 8;
  if (c.priorGoodCollection) pts += 6;
  if (c.priorRugged) pts -= 10;
  if (c.description && c.description.length > 80) pts += 3;
  if (c.image) pts += 2;
  return clamp(pts, 20);
}

function scoreTiming(c) {
  let pts = 0;
  if (c.isMinting) pts += 8;
  else {
    const starts = (c.stages || [])
      .map(s => hoursUntil(s.start_time))
      .filter(h => Number.isFinite(h) && h >= 0);
    const soon = starts.length ? Math.min(...starts) : Infinity;
    if (soon <= 6) pts += 7;
    else if (soon <= 24) pts += 5;
  }
  if (c.maxSupply) pts += 4;
  const price = c.priceEth;
  if (price == null || price === 0) pts += 2;
  else if (price > 0 && price <= 0.15) pts += 3;
  else if (price <= 0.5) pts += 2;
  else if (price <= 1) pts += 1;
  return clamp(pts, 15);
}

function whyLine(c) {
  if (c.isMinting && (c.minters6h || 0) >= 8) {
    return `Organic mint velocity — ${c.minters6h} unique minters in 6h.`;
  }
  if (c.isMinting && c.verified) return 'Live mint, verified contract, tradeable size.';
  if (c.isMinting) return 'Mint is live with a real OpenSea drop page.';
  const starts = (c.stages || []).find(s => s.start_time && new Date(s.start_time) > new Date());
  if (starts) return `Starts today — ${starts.label || 'public'} stage on the calendar.`;
  if (c.twitterUrl && c.siteUrl) return 'Real surface (site + X) and a capped supply.';
  if (c.chain === 'robinhood') return 'Fresh RH collection with a contract you can actually check.';
  return 'Cleared quality filters with a real contract and mint window.';
}

function scoreCandidate(c) {
  const onchain = scoreOnchain(c);
  const social = scoreSocial(c);
  const team = scoreTeam(c);
  const timing = scoreTiming(c);
  const total = onchain + social + team + timing;
  return {
    ...c,
    score: { total, onchain, social, team, timing },
    why: whyLine({ ...c, score: { total } }),
    activeStageKey: (c.stages || [])[0]?.label || (c.stages || [])[0]?.stage_type || (c.isMinting ? 'live' : null)
  };
}

function pickList(scored) {
  const ranked = [...scored].sort((a, b) => (b.score?.total || 0) - (a.score?.total || 0));
  let passed = ranked.filter(c => (c.score?.total || 0) >= 60);
  if (passed.length < 3) {
    passed = ranked.filter(c => (c.score?.total || 0) >= 50);
  }
  return passed.slice(0, 8);
}

module.exports = {
  scoreCandidate,
  pickList,
  scoreOnchain,
  scoreSocial,
  scoreTeam,
  scoreTiming,
  whyLine
};
