const fs = require('fs');
const path = require('path');
const { STAGE_WINDOW_HOURS } = require('./config');
const { postedWithinDays, hoursSincePosted, previousScore, previousStage, isBlacklistedDeployer } = require('./store');

const SPAM_NAME =
  /\b(ai ape|pixel punks|bored ape|azuki|pudgy penguin|clone|copy|whitelist pass|wl pass|mint pass xyz|generic pfp)\b/i;
const ORANGEHARE = /orange[\s_-]*hare/i;

function loadBlacklist() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'blacklist.json'), 'utf8'));
  } catch {
    return { slugs: [], nameHints: [] };
  }
}

function hoursUntil(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (t - Date.now()) / 36e5;
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 36e5;
}

function activeStageKey(candidate) {
  const stage = (candidate.stages || []).find(s => s?.start_time) || (candidate.stages || [])[0];
  const key = String(
    stage?.label || stage?.stage_type || candidate.status || (candidate.isMinting ? 'live' : '')
  ).toLowerCase();
  return key || null;
}

function mintInWindow(candidate) {
  if (candidate.isMinting) return true;
  const stages = candidate.stages || [];
  if (!stages.length) {
    if (candidate.firstMintAt && hoursSince(candidate.firstMintAt) <= STAGE_WINDOW_HOURS) return true;
    return false;
  }
  const now = Date.now();
  const windowMs = STAGE_WINDOW_HOURS * 36e5;
  return stages.some(s => {
    const start = s.start_time ? new Date(s.start_time).getTime() : NaN;
    const end = s.end_time ? new Date(s.end_time).getTime() : Infinity;
    if (Number.isNaN(start)) return false;
    const live = start <= now && now <= end;
    const upcoming = start > now && start - now <= windowMs;
    return live || upcoming;
  });
}

function hasSurface(candidate) {
  return Boolean(candidate.url || candidate.siteUrl || candidate.twitterUrl);
}

function shouldSkipAsRepeat(candidate) {
  if (!postedWithinDays(candidate, 7)) return null;
  const stageChanged =
    previousStage(candidate) &&
    activeStageKey(candidate) &&
    previousStage(candidate) !== activeStageKey(candidate) &&
    hoursSincePosted(candidate) > 18;
  const jumped =
    candidate.score?.total &&
    previousScore(candidate) &&
    candidate.score.total - previousScore(candidate) >= 15 &&
    hoursSincePosted(candidate) > 18;
  if (stageChanged) return null;
  if (jumped) return null;
  return 'already posted in last 7 days';
}

function hardReject(candidate) {
  const bl = loadBlacklist();
  const name = String(candidate.name || '');
  const slug = String(candidate.slug || '').toLowerCase();
  const hay = `${name} ${slug} ${candidate.siteUrl || ''} ${candidate.description || ''}`.toLowerCase();

  if (!candidate.contractAddress) return 'no contract address';
  if (!mintInWindow(candidate)) return 'mint not live and no stage in next 24h';

  const minted = Number(candidate.totalSupply ?? 0);
  const uniqueMinters = candidate.uniqueMinters;
  const uniqueHolders = candidate.uniqueHolders;
  if (
    candidate.maxSupply == null &&
    minted < 5 &&
    uniqueMinters != null &&
    uniqueMinters < 3
  ) {
    return 'too dead / too fake';
  }

  if (minted >= 50 && uniqueHolders != null && uniqueHolders < 8) {
    return 'bot farm (holders < 8 after 50+ minted)';
  }
  if (minted >= 50 && uniqueMinters != null && uniqueMinters < 8) {
    return 'bot farm (minters < 8 after 50+ minted)';
  }

  if (candidate.topHolderPct != null && candidate.topHolderPct > 25) {
    return 'top wallet holds > 25%';
  }
  if (candidate.deployerMintPct != null && candidate.deployerMintPct > 20) {
    return 'deployer minted a large % to self';
  }

  if (
    !candidate.hasMetadata &&
    !candidate.image &&
    !candidate.siteUrl &&
    !candidate.twitterUrl
  ) {
    return 'no metadata / image / socials';
  }

  if (SPAM_NAME.test(name) || SPAM_NAME.test(slug)) return 'generic spam name';
  if (ORANGEHARE.test(hay) || (bl.slugs || []).includes(slug)) return 'blacklisted project';
  if ((bl.nameHints || []).some(h => hay.includes(String(h).toLowerCase()))) {
    return 'blacklisted project';
  }

  if (!hasSurface(candidate)) return 'no website, X, or OpenSea page';

  if (
    candidate.verified === false &&
    !String(candidate.source || '').includes('opensea') &&
    minted < 20
  ) {
    return 'unverified contract with no OpenSea drop and minted < 20';
  }

  const price = candidate.priceEth;
  const social = candidate.twitterUrl || candidate.siteUrl;
  if (price != null && price > 2 && !social) return 'absurd mint price with zero social proof';

  if (isBlacklistedDeployer(candidate.deployer)) return 'deployer blacklisted';

  return null;
}

module.exports = {
  hardReject,
  shouldSkipAsRepeat,
  mintInWindow,
  activeStageKey,
  hoursUntil,
  hoursSince,
  SPAM_NAME
};
