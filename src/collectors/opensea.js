const { OPENSEA_API_KEY, CHAINS, LOOKBACK_HOURS } = require('../config');
const { getJson } = require('../http');
const { log } = require('../log');

const HEADERS = {
  Accept: 'application/json',
  'X-API-KEY': OPENSEA_API_KEY
};

function explorerUrl(chain, address) {
  const base = CHAINS[chain]?.explorer;
  if (!base || !address) return null;
  if (chain === 'robinhood') return `${base}/address/${address}`;
  return `${base}/address/${address}`;
}

function twitterUrl(username) {
  if (!username) return null;
  const u = String(username).replace(/^@/, '');
  return `https://x.com/${u}`;
}

function weiToEth(wei) {
  const n = Number(wei);
  if (!Number.isFinite(n) || n === 0) return n === 0 ? 0 : null;
  return n / 1e18;
}

function normalizeDrop(drop, source) {
  const chain = String(drop.chain || '').toLowerCase();
  if (chain !== 'ethereum' && chain !== 'robinhood') return null;
  const stages = [drop.active_stage, drop.next_stage, ...(drop.stages || [])].filter(Boolean);
  const price = weiToEth(stages.find(s => s.price != null)?.price);
  const addr = drop.contract_address || drop.contracts?.[0]?.address || null;
  const slug = drop.collection_slug || drop.slug;
  return {
    name: drop.collection_name || drop.name,
    chain,
    slug,
    contractAddress: addr,
    url: drop.opensea_url || (slug ? `https://opensea.io/collection/${slug}` : null),
    explorerUrl: explorerUrl(chain, addr),
    twitterUrl: twitterUrl(drop.twitter_username),
    mintUrl: drop.opensea_url || null,
    siteUrl: drop.project_url || null,
    discordUrl: drop.discord_url || null,
    image: drop.image_url || drop.image || null,
    description: drop.description || null,
    deployer: drop.owner || null,
    verified: drop.safelist_status === 'verified' ? true : null,
    isMinting: drop.is_minting === true,
    mintedOut: false,
    stages,
    maxSupply: drop.max_supply != null ? Number(drop.max_supply) : null,
    totalSupply: drop.total_supply != null ? Number(drop.total_supply) : null,
    uniqueMinters: null,
    uniqueHolders: null,
    topHolderPct: null,
    deployerMintPct: null,
    minters1h: null,
    minters6h: null,
    minters24h: null,
    priceEth: price,
    priceLabel: price == null ? 'TBD' : price === 0 ? 'Free' : `${price.toFixed(4)} ETH`,
    source,
    firstMintAt: stages[0]?.start_time || drop.created_date || null,
    createdAt: drop.created_date || null,
    hasMetadata: Boolean(drop.image_url || drop.image || drop.description),
    hasRoyalty: false,
    isDisabled: drop.is_disabled === true,
    safelistStatus: drop.safelist_status || null
  };
}

async function fetchDropsPages(type, chain, maxPages = 3) {
  const out = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const params = { type, chains: chain, limit: 50 };
    if (cursor) params.cursor = cursor;
    const data = await getJson('https://api.opensea.io/api/v2/drops', {
      params,
      headers: HEADERS,
      timeout: 15000
    });
    if (!data) break;
    out.push(...(data.drops || []));
    cursor = data.next || null;
    if (!cursor) break;
  }
  return out;
}

async function fetchNewCollections(chain) {
  const data = await getJson('https://api.opensea.io/api/v2/collections', {
    params: { chain, order_by: 'created_date', limit: 50 },
    headers: HEADERS,
    timeout: 15000
  });
  if (!data) return [];
  const rows = data.collections || data.results || [];
  const cutoff = Date.now() - LOOKBACK_HOURS * 36e5;
  return rows
    .filter(c => {
      const created = c.created_date ? new Date(c.created_date).getTime() : 0;
      return !created || created >= cutoff;
    })
    .map(c => ({
      ...c,
      chain,
      collection_slug: c.collection || c.slug,
      collection_name: c.name,
      opensea_url: c.opensea_url,
      image_url: c.image_url,
      project_url: c.project_url,
      twitter_username: c.twitter_username,
      discord_url: c.discord_url,
      owner: c.owner,
      is_disabled: c.is_disabled,
      safelist_status: c.safelist_status,
      contracts: c.contracts,
      contract_address: c.contracts?.[0]?.address
    }));
}

async function enrichDrop(drop) {
  const slug = drop.collection_slug || drop.slug;
  if (!slug) return drop;
  const [detail, collection] = await Promise.all([
    getJson(`https://api.opensea.io/api/v2/drops/${slug}`, { headers: HEADERS, silent: true }),
    getJson(`https://api.opensea.io/api/v2/collections/${slug}`, { headers: HEADERS, silent: true })
  ]);
  return {
    ...drop,
    ...(detail || {}),
    chain: drop.chain || detail?.chain,
    description: collection?.description || drop.description,
    project_url: collection?.project_url || drop.project_url,
    twitter_username: collection?.twitter_username || drop.twitter_username,
    discord_url: collection?.discord_url || drop.discord_url,
    owner: collection?.owner || drop.owner,
    created_date: collection?.created_date || drop.created_date,
    is_disabled: collection?.is_disabled,
    safelist_status: collection?.safelist_status,
    contracts: collection?.contracts || drop.contracts,
    contract_address:
      drop.contract_address || detail?.contract_address || collection?.contracts?.[0]?.address,
    image_url: drop.image_url || detail?.image_url || collection?.image_url
  };
}

async function collectOpenSea() {
  if (!OPENSEA_API_KEY) {
    log('OpenSea: no OPENSEA_API_KEY, skipping');
    return [];
  }

  const map = new Map();
  for (const chain of ['ethereum', 'robinhood']) {
    for (const type of ['featured', 'upcoming', 'recently_minted']) {
      const drops = await fetchDropsPages(type, chain);
      log(`OpenSea ${type} ${chain}: ${drops.length}`);
      for (const drop of drops) {
        const slug = drop.collection_slug;
        if (!slug || map.has(slug)) continue;
        map.set(slug, { ...drop, chain: drop.chain || chain, sourceType: `opensea-${type}` });
      }
    }
    const fresh = await fetchNewCollections(chain);
    log(`OpenSea collections ${chain}: ${fresh.length}`);
    for (const row of fresh) {
      const slug = row.collection_slug;
      if (!slug || map.has(slug)) continue;
      map.set(slug, { ...row, sourceType: 'opensea-collection' });
    }
  }

  const enriched = [];
  const values = [...map.values()];
  for (let i = 0; i < values.length; i += 5) {
    const batch = values.slice(i, i + 5);
    const done = await Promise.all(batch.map(enrichDrop));
    enriched.push(...done);
  }

  return enriched
    .map(d => normalizeDrop(d, d.sourceType || 'opensea'))
    .filter(Boolean);
}

module.exports = { collectOpenSea, normalizeDrop, explorerUrl };
