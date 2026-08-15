require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  Events
} = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function log(message) {
  console.log(String(message).replace(/\s+/g, ' ').slice(0, 400));
}

function logError(label, err) {
  const status = err?.status ?? err?.response?.status ?? err?.code;
  const msg = err?.rawError?.message || err?.message || String(err);
  log(`${label}${status ? ` (${status})` : ''}: ${msg}`);
}

function safeImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

const OPENSEA_HEADERS = {
  Accept: 'application/json',
  'X-API-KEY': process.env.OPENSEA_API_KEY || ''
};

const ALLOWED_CHAINS = new Set(['ethereum', 'robinhood']);
const EMBEDS_PER_MESSAGE = 10;
const MAX_OPENSEA_PAGES = 8;
const RECENT_START_HOURS = 48;
const MINTED_OUT_MAX_AGE_HOURS = 8;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const POSTED_TTL_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = path.join(__dirname, 'data', 'state.json');
const GOPLUS_CHAIN_IDS = { ethereum: '1', robinhood: '4663' };
const ORANGEHARE_RE = /orange[\s_-]*hare/i;
const ORANGEHARE_SLUGS = new Set([
  'orangehare-exclusives',
  'orangehare-korean-pop-revolution-1',
  'seoul-city-korean-artists-orangehare',
  'cheap-shot',
  'beast-battle',
  'bone-theater',
  'sacred-mythos',
  'steel-garden',
  'knuckle-up'
]);

// ---------- Helpers ----------
function pacificNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function zonedYmd(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(date);
  const get = type => Number(parts.find(p => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

function isToday(isoString) {
  if (!isoString) return false;
  const date = isoString instanceof Date ? isoString : new Date(isoString);
  if (Number.isNaN(date.getTime())) return false;
  const a = zonedYmd(date);
  const b = zonedYmd();
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

function isWithinHours(isoString, hours) {
  if (!isoString) return false;
  const t = new Date(isoString).getTime();
  if (Number.isNaN(t)) return false;
  const delta = Date.now() - t;
  return delta >= -hours * 36e5 && delta <= hours * 36e5;
}

function allStages(drop) {
  return [drop.active_stage, drop.next_stage, ...(drop.stages || [])].filter(Boolean);
}

function chainOf(drop) {
  return String(drop.chain || '').toLowerCase();
}

function isAllowedChain(chain) {
  return ALLOWED_CHAINS.has(String(chain || '').toLowerCase());
}

function isRobinhood(drop) {
  return chainOf(drop).includes('robinhood');
}

function chainLabel(drop) {
  return isRobinhood(drop) ? 'Robinhood' : 'Ethereum';
}

function isOrangeHare(drop, extraText = '') {
  const slug = String(drop.slug || drop.collection_slug || '').toLowerCase();
  if (ORANGEHARE_SLUGS.has(slug)) return true;

  const haystack = [
    drop.name,
    drop.collection_name,
    slug,
    drop.url,
    drop.opensea_url,
    drop.image,
    drop.image_url,
    drop.description,
    drop.project_url,
    drop.twitter_username,
    drop.discord_url,
    drop.owner,
    extraText
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    ORANGEHARE_RE.test(haystack) ||
    haystack.includes('orangehare.io') ||
    haystack.includes('orangehare_network') ||
    haystack.includes('orangehare_io')
  );
}

function isSoldOut(drop) {
  const max = Number(drop.max_supply || drop.maxSupply || 0);
  const total = Number(drop.total_supply || drop.totalSupply || 0);
  return max > 0 && total >= max;
}

function hoursSince(isoString) {
  if (!isoString) return Infinity;
  const t = new Date(isoString).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 36e5;
}

// Minted-out drops only stay on the list for a short window.
function wasMintedOutRecently(drop, hours = MINTED_OUT_MAX_AGE_HOURS) {
  const stages = allStages(drop);
  let bestAge = Infinity;

  for (const stage of stages) {
    if (stage?.end_time) {
      const age = hoursSince(stage.end_time);
      if (age >= 0) bestAge = Math.min(bestAge, age);
    }
    if (stage?.start_time) {
      const age = hoursSince(stage.start_time);
      if (age >= 0) bestAge = Math.min(bestAge, age);
    }
  }

  if (drop.created_date) {
    const age = hoursSince(drop.created_date);
    if (age >= 0) bestAge = Math.min(bestAge, age);
  }

  return Number.isFinite(bestAge) && bestAge <= hours;
}

function stageWindowOverlapsToday(stage) {
  if (!stage?.start_time) return false;

  const today = pacificNow();
  const startOfDay = new Date(today);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today);
  endOfDay.setHours(23, 59, 59, 999);

  const start = new Date(stage.start_time).getTime();
  const end = stage.end_time ? new Date(stage.end_time).getTime() : Infinity;
  if (Number.isNaN(start)) return false;

  return start <= endOfDay.getTime() && end >= startOfDay.getTime() && start <= Date.now();
}

function stageIsRelevant(stage) {
  if (!stage) return false;
  return (
    isToday(stage.start_time) ||
    isToday(stage.end_time) ||
    isWithinHours(stage.start_time, RECENT_START_HOURS) ||
    stageWindowOverlapsToday(stage)
  );
}

function dropBelongsOnTodaysList(drop) {
  const soldOut = isSoldOut(drop);
  // Hide minted-out projects once they are older than MINTED_OUT_MAX_AGE_HOURS.
  if (soldOut && !wasMintedOutRecently(drop)) return false;

  if (drop.is_minting === true) return true;
  if (isToday(drop.created_date) || isWithinHours(drop.created_date, RECENT_START_HOURS)) {
    return true;
  }

  const stages = allStages(drop);
  const recentlyMinted = String(drop.source || '').includes('recently_minted');

  if (recentlyMinted) return true;
  if (stages.some(s => isToday(s.start_time) || isToday(s.end_time) || isWithinHours(s.start_time, RECENT_START_HOURS))) {
    return true;
  }
  if (!soldOut && stages.some(stageWindowOverlapsToday)) return true;

  return false;
}

function formatPrice(stage) {
  if (!stage || stage.price == null || stage.price === '') return 'Free / TBD';
  const wei = Number(stage.price);
  if (!Number.isFinite(wei) || wei === 0) return 'Free';
  return `${(wei / 1e18).toFixed(4)} ETH`;
}

function formatSupply(drop) {
  if (drop.maxSupply == null && drop.max_supply == null) {
    return drop.mintedOut ? 'Minted out' : 'Check site';
  }
  const total = drop.totalSupply ?? drop.total_supply ?? 0;
  const max = drop.maxSupply ?? drop.max_supply;
  const supply = `${total} / ${max}`;
  return drop.mintedOut || isSoldOut(drop) ? `${supply} · Minted out` : supply;
}

function formatStart(stage) {
  if (!stage?.start_time) return 'TBD';
  return new Date(stage.start_time).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

function todayDateTokens() {
  const today = pacificNow();
  const monthLong = today.toLocaleString('en-US', { month: 'long' }).toLowerCase();
  const monthShort = today.toLocaleString('en-US', { month: 'short' }).toLowerCase();
  const day = today.getDate();
  const year = today.getFullYear();
  return [
    `${monthShort} ${day}`,
    `${monthLong} ${day}`,
    `${monthShort} ${day}, ${year}`,
    `${monthLong} ${day}, ${year}`
  ];
}

function dateRangeIncludesToday(text) {
  const match = String(text || '').match(
    /([A-Za-z]{3,9}\s+\d{1,2},?\s*\d{4})\s*[–\-—to]+\s*([A-Za-z]{3,9}\s+\d{1,2},?\s*\d{4})/i
  );
  if (!match) return false;

  const start = new Date(match[1]);
  const end = new Date(match[2]);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;

  const today = pacificNow();
  today.setHours(0, 0, 0, 0);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return today >= start && today <= end;
}

function normalizeDrop(drop) {
  const stages = allStages(drop);
  const relevant = stages.filter(stageIsRelevant);
  return {
    name: drop.collection_name || drop.name,
    chain: chainOf(drop) || 'ethereum',
    slug: drop.collection_slug || drop.slug,
    url: drop.opensea_url || drop.url || `https://opensea.io/collection/${drop.collection_slug || drop.slug}`,
    image: drop.image_url || drop.image || null,
    maxSupply: drop.max_supply ?? drop.maxSupply ?? null,
    totalSupply: drop.total_supply ?? drop.totalSupply ?? null,
    mintedOut: isSoldOut(drop),
    stages: relevant.length > 0 ? relevant : stages.slice(0, 1),
    source: drop.source || 'opensea',
    contractAddress: drop.contract_address || drop.contractAddress || drop.contracts?.[0]?.address || null,
    isDisabled: drop.is_disabled ?? drop.isDisabled ?? false,
    safelistStatus: drop.safelist_status || drop.safelistStatus || null
  };
}

function sortDrops(drops) {
  return [...drops].sort((a, b) => {
    const soldCmp = Number(Boolean(a.mintedOut)) - Number(Boolean(b.mintedOut));
    if (soldCmp !== 0) return soldCmp;
    const chainCmp = Number(isRobinhood(b)) - Number(isRobinhood(a));
    if (chainCmp !== 0) return chainCmp;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ---------- Remember posted drops ----------
function defaultState() {
  return { lastManualDropsAt: 0, posted: {}, safety: {} };
}

function loadState() {
  try {
    return { ...defaultState(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function pruneState(state) {
  const cutoff = Date.now() - POSTED_TTL_MS;
  for (const [slug, at] of Object.entries(state.posted || {})) {
    if (at < cutoff) delete state.posted[slug];
  }
  for (const [key, entry] of Object.entries(state.safety || {})) {
    if (!entry?.at || entry.at < cutoff) delete state.safety[key];
  }
  return state;
}

function wasPostedRecently(state, slug) {
  const at = state.posted?.[slug];
  return Boolean(at && Date.now() - at < POSTED_TTL_MS);
}

function markPosted(slugs, { manual = false } = {}) {
  const state = pruneState(loadState());
  const now = Date.now();
  if (manual) state.lastManualDropsAt = now;
  for (const slug of slugs) {
    if (slug) state.posted[slug] = now;
  }
  saveState(state);
}

function usedDropsRecently() {
  const state = loadState();
  return Date.now() - (state.lastManualDropsAt || 0) < SIX_HOURS_MS;
}

async function fetchJson(url, options = {}) {
  try {
    const res = await axios.get(url, { timeout: 8000, ...options });
    return res.data;
  } catch {
    return null;
  }
}

async function isExplorerVerified(chain, address) {
  if (chain === 'robinhood') {
    const v2 = await fetchJson(`https://robinhoodchain.blockscout.com/api/v2/smart-contracts/${address}`);
    if (v2 && (v2.is_verified || v2.is_fully_verified)) return true;
    const legacy = await fetchJson('https://robinhoodchain.blockscout.com/api', {
      params: { module: 'contract', action: 'getsourcecode', address }
    });
    return Boolean(legacy?.result?.[0]?.SourceCode);
  }

  const v2 = await fetchJson(`https://eth.blockscout.com/api/v2/smart-contracts/${address}`);
  if (v2 && (v2.is_verified || v2.is_fully_verified)) return true;

  const params = {
    chainid: 1,
    module: 'contract',
    action: 'getsourcecode',
    address
  };
  if (process.env.ETHERSCAN_API_KEY) params.apikey = process.env.ETHERSCAN_API_KEY;
  const etherscan = await fetchJson('https://api.etherscan.io/v2/api', { params });
  return Boolean(etherscan?.result?.[0]?.SourceCode);
}

async function goplusNftFlags(chain, address) {
  const chainId = GOPLUS_CHAIN_IDS[chain];
  if (!chainId) return {};
  const data = await fetchJson(`https://api.gopluslabs.io/api/v1/nft_security/${chainId}`, {
    params: { contract_addresses: address }
  });
  const result = data?.result;
  if (!result || typeof result !== 'object') return {};
  if (result.malicious_nft_contract != null || result.nft_open_source != null) return result;
  return result[address] || result[address.toLowerCase()] || {};
}

function looksMalicious(drop, flags = {}) {
  if (drop.isDisabled || drop.is_disabled) return true;
  const status = String(drop.safelistStatus || drop.safelist_status || '').toLowerCase();
  if (status === 'disabled' || status.includes('malware') || status.includes('spam')) return true;
  const malicious = flags.malicious_nft_contract;
  return malicious === '1' || malicious === 1 || malicious === true;
}

function isOpenSourceFlag(flags = {}) {
  const open = flags.nft_open_source;
  return open === '1' || open === 1 || open === true;
}

async function dropIsSafeAndVerified(drop) {
  if (looksMalicious(drop)) return false;

  const address = drop.contractAddress || drop.contract_address;
  if (!address) return false;

  const chain = chainOf(drop);
  const flags = await goplusNftFlags(chain, address);
  if (looksMalicious(drop, flags)) return false;
  if (isOpenSourceFlag(flags)) return true;
  return isExplorerVerified(chain, address);
}

async function cachedSafety(drop, state) {
  const address = String(drop.contractAddress || drop.contract_address || '').toLowerCase();
  const key = `${chainOf(drop)}:${address || drop.slug}`;
  const hit = state.safety?.[key];
  if (hit && Date.now() - hit.at < SIX_HOURS_MS) return hit.ok;

  const ok = await dropIsSafeAndVerified(drop);
  state.safety = state.safety || {};
  state.safety[key] = { ok, at: Date.now() };
  return ok;
}

async function filterSafeVerified(drops) {
  const state = pruneState(loadState());
  const checked = await mapPool(drops, 4, async drop => ({
    drop,
    ok: await cachedSafety(drop, state)
  }));
  saveState(state);
  return checked.filter(item => item.ok).map(item => item.drop);
}

// ---------- OpenSea ----------
async function fetchOpenSeaPages(type, chains, maxPages = MAX_OPENSEA_PAGES) {
  const drops = [];
  let cursor;
  let pages = 0;

  do {
    try {
      const params = { type, chains, limit: 100 };
      if (cursor) params.cursor = cursor;

      const res = await axios.get('https://api.opensea.io/api/v2/drops', {
        params,
        headers: OPENSEA_HEADERS,
        timeout: 15000
      });

      drops.push(...(res.data.drops || []));
      cursor = res.data.next || null;
      pages += 1;
    } catch (err) {
      logError(`OpenSea ${type} / ${chains} failed`, err);
      break;
    }
  } while (cursor && pages < maxPages);

  return drops;
}

async function enrichOpenSeaDrop(drop) {
  const [detailRes, collectionRes] = await Promise.allSettled([
    axios.get(`https://api.opensea.io/api/v2/drops/${drop.collection_slug}`, {
      headers: OPENSEA_HEADERS,
      timeout: 10000
    }),
    axios.get(`https://api.opensea.io/api/v2/collections/${drop.collection_slug}`, {
      headers: OPENSEA_HEADERS,
      timeout: 10000
    })
  ]);

  const detail = detailRes.status === 'fulfilled' ? detailRes.value.data : {};
  const collection = collectionRes.status === 'fulfilled' ? collectionRes.value.data : {};

  return {
    ...drop,
    ...detail,
    source: drop.source,
    description: collection.description,
    project_url: collection.project_url,
    twitter_username: collection.twitter_username,
    discord_url: collection.discord_url,
    owner: collection.owner,
    created_date: collection.created_date,
    is_disabled: collection.is_disabled,
    safelist_status: collection.safelist_status,
    contracts: collection.contracts,
    contract_address: drop.contract_address || detail.contract_address || collection.contracts?.[0]?.address
  };
}

async function fetchOpenSeaDrops() {
  const chainAttempts = ['ethereum,robinhood'];
  const typeAttempts = [
    { type: 'recently_minted', pages: MAX_OPENSEA_PAGES },
    { type: 'featured', pages: MAX_OPENSEA_PAGES },
    { type: 'upcoming', pages: MAX_OPENSEA_PAGES }
  ];
  const resultsMap = new Map();

  for (const chains of chainAttempts) {
    for (const { type, pages } of typeAttempts) {
      const drops = await fetchOpenSeaPages(type, chains, pages);
      for (const drop of drops) {
        const slug = drop.collection_slug;
        if (!slug || resultsMap.has(slug)) continue;
        if (!isAllowedChain(drop.chain)) continue;
        if (isOrangeHare(drop)) continue;
        resultsMap.set(slug, { ...drop, source: `opensea-${type}` });
      }
    }
  }

  const enriched = await mapPool([...resultsMap.values()], 5, enrichOpenSeaDrop);
  const kept = [];

  for (const drop of enriched) {
    if (!isAllowedChain(drop.chain)) continue;
    if (isOrangeHare(drop)) continue;
    if (!dropBelongsOnTodaysList(drop)) continue;
    kept.push(normalizeDrop(drop));
  }

  return kept;
}

// ---------- nftcalendar scrape ----------
async function fetchNftCalendarFallback(existingSlugs = new Set()) {
  const results = [];
  const pages = [
    { url: 'https://nftcalendar.io/b/robinhood/', chain: 'robinhood' },
    { url: 'https://nftcalendar.io/b/ethereum/', chain: 'ethereum' },
    { url: 'https://nftcalendar.io/', chain: null }
  ];
  const todayTokens = todayDateTokens();

  for (const page of pages) {
    try {
      const { data } = await axios.get(page.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NFTBot/1.0)' },
        timeout: 10000
      });
      const $ = cheerio.load(data);

      $('article, .event, .drop, .event-item, .card').each((_, el) => {
        const container = $(el);
        const titleEl = container.find('h2, h3, .event-title, .drop-title').first();
        const title = (titleEl.text() || container.find('a').first().text() || '').trim();
        if (!title || title.length < 4) return;

        const text = (container.text() || '').toLowerCase();
        const link = container.find('a').attr('href') || titleEl.find('a').attr('href') || '';

        let chain = page.chain;
        if (!chain) {
          const isRobinhoodPage = text.includes('robinhood') || link.includes('robinhood');
          const isEth =
            text.includes('ethereum') ||
            text.includes(' eth ') ||
            link.includes('ethereum');
          if (isRobinhoodPage) chain = 'robinhood';
          else if (isEth) chain = 'ethereum';
          else return;
        }

        const mentionsToday =
          dateRangeIncludesToday(container.text()) ||
          todayTokens.some(token => text.includes(token)) ||
          text.includes('today') ||
          text.includes('minting now') ||
          text.includes('minted out') ||
          text.includes('sold out');

        if (!mentionsToday) return;

        const slugGuess = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 60);

        if (isOrangeHare({ name: title, slug: slugGuess, url: link }, container.text())) return;
        if (existingSlugs.has(slugGuess) || results.some(r => r.slug === slugGuess)) return;

        results.push({
          name: title,
          chain,
          slug: slugGuess,
          url: link.startsWith('http') ? link : `https://nftcalendar.io${link}`,
          image: container.find('img').attr('src') || container.find('img').attr('data-src') || null,
          maxSupply: null,
          totalSupply: null,
          mintedOut: text.includes('minted out') || text.includes('sold out'),
          stages: [{ label: 'Check site / Live', start_time: new Date().toISOString(), price: null }],
          source: 'nftcalendar'
        });
      });
    } catch (err) {
      logError(`nftcalendar scrape failed (${page.url})`, err);
    }
  }

  return results;
}

// ---------- Combine ----------
async function getTodaysMints({ skipPosted = false } = {}) {
  const openSea = await fetchOpenSeaDrops();
  const existing = new Set(openSea.map(d => d.slug));
  const fallback = await fetchNftCalendarFallback(existing);
  let drops = sortDrops([...openSea, ...fallback].filter(drop => !isOrangeHare(drop)));
  // Also apply the minted-out age cutoff to nftcalendar / normalized drops.
  drops = drops.filter(drop => !drop.mintedOut || wasMintedOutRecently(drop));
  drops = await filterSafeVerified(drops);
  if (skipPosted) {
    const state = loadState();
    drops = drops.filter(drop => !wasPostedRecently(state, drop.slug));
  }
  return drops;
}

// ---------- Embeds: one compact list with small thumbnails ----------
function buildListEmbeds(drops) {
  const mintedOutCount = drops.filter(d => d.mintedOut).length;
  const rhCount = drops.filter(isRobinhood).length;
  const ethCount = drops.length - rhCount;
  const today = pacificNow().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const lines = drops.map((drop, index) => {
    const stage = (drop.stages || [])[0];
    const icon = isRobinhood(drop) ? '🟢' : '🟣';
    return `${icon} **${index + 1}. [${drop.name}](${drop.url})**\n${chainLabel(drop)} · ${formatSupply(drop)} · ${formatPrice(stage)} · ${formatStart(stage)} PST`;
  });

  const descriptions = [];
  let current = [];
  let length = 0;
  for (const line of lines) {
    if (current.length && length + line.length + 2 > 3900) {
      descriptions.push(current.join('\n\n'));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 2;
  }
  if (current.length) descriptions.push(current.join('\n\n'));

  return descriptions.map((description, index) => {
    const embed = new EmbedBuilder()
      .setColor(0x111111)
      .setDescription(description);

    if (index === 0) {
      embed
        .setTitle(`Today's NFT Mints · ${today}`)
        .setFooter({
          text: `${drops.length} projects · 🟢 Robinhood ${rhCount} · 🟣 Ethereum ${ethCount} · ${mintedOutCount} minted out`
        })
        .setTimestamp();
    } else {
      embed.setTitle("Today's NFT Mints · continued");
    }

    return embed;
  });
}

function buildThumbEmbed(drop) {
  const stage = (drop.stages || [])[0];
  const embed = new EmbedBuilder()
    .setTitle(drop.name)
    .setURL(drop.url)
    .setColor(drop.mintedOut ? 0x888888 : isRobinhood(drop) ? 0x00c805 : 0x627eea)
    .setDescription(
      `**${chainLabel(drop)}** · ${formatSupply(drop)} · ${formatPrice(stage)}\n${stage?.label || stage?.stage_type || 'Mint'} · ${formatStart(stage)} PST`
    )
    .setFooter({ text: `Source: ${drop.source}` });

  const image = safeImageUrl(drop.image);
  if (image) embed.setThumbnail(image);
  return embed;
}

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function sendPayloads(channel, payloads, isSlash) {
  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    try {
      if (isSlash) {
        if (i === 0) await channel.editReply(payload);
        else await channel.followUp(payload);
      } else {
        await channel.send(payload);
      }
    } catch (err) {
      logError(`Failed to post mint batch ${i + 1}/${payloads.length}`, err);
    }
    if (i < payloads.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
}

// ---------- Post ----------
async function postDrops(channel, { isSlash = false, skipPosted = false } = {}) {
  const drops = await getTodaysMints({ skipPosted });

  if (drops.length === 0) {
    const msg = 'No verified ETH or Robinhood mints to show right now.';
    if (isSlash) return channel.editReply({ content: msg });
    log('Scheduled post skipped: nothing new after filters.');
    return;
  }

  const listEmbeds = buildListEmbeds(drops);
  const thumbEmbeds = drops.map(buildThumbEmbed);
  const payloads = [];

  payloads.push({
    content: `**Today's NFT Mints** (${drops.length}) — Ethereum + Robinhood`,
    embeds: listEmbeds.slice(0, EMBEDS_PER_MESSAGE)
  });

  for (const batch of chunk(listEmbeds.slice(EMBEDS_PER_MESSAGE), EMBEDS_PER_MESSAGE)) {
    payloads.push({ embeds: batch });
  }

  for (const batch of chunk(thumbEmbeds, EMBEDS_PER_MESSAGE)) {
    payloads.push({ embeds: batch });
  }

  await sendPayloads(channel, payloads, isSlash);
  markPosted(drops.map(drop => drop.slug), { manual: isSlash });
}

// ---------- Slash Command ----------
const commands = [
  new SlashCommandBuilder()
    .setName('drops')
    .setDescription("Show today's verified ETH + Robinhood NFT mints")
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  log('Slash commands registered');
}

async function onReady() {
  log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    logError('Failed to register slash commands', err);
  }
}

client.once(Events.ClientReady ?? 'clientReady', onReady);

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'drops') return;

  try {
    await interaction.deferReply();
    await postDrops(interaction, { isSlash: true });
  } catch (err) {
    logError('/drops failed', err);
    try {
      const msg = "Could not fetch today's mints. Try again in a minute.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch (_) {
      // ignore follow-up failures
    }
  }
});

cron.schedule(
  '0 */6 * * *',
  async () => {
    if (usedDropsRecently()) {
      log('Skipping scheduled post; /drops was used in the last 6 hours.');
      return;
    }
    log('Running 6-hour mint alert...');
    try {
      const channel = await client.channels.fetch(process.env.CHANNEL_ID);
      await postDrops(channel, { skipPosted: true });
    } catch (err) {
      logError('Scheduled post failed', err);
    }
  },
  { timezone: 'America/Los_Angeles' }
);

process.on('unhandledRejection', err => {
  logError('Unhandled rejection', err);
});

process.on('uncaughtException', err => {
  logError('Uncaught exception', err);
});

client.login(process.env.DISCORD_TOKEN);
