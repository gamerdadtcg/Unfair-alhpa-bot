const { CHAINS, FIRST_MINT_HOURS, BLOCKSCOUT_KEY } = require('../config');
const { getJson } = require('../http');
const { log } = require('../log');
const { explorerUrl } = require('./opensea');

async function recentTokens(base) {
  const headers = BLOCKSCOUT_KEY ? { Authorization: `Bearer ${BLOCKSCOUT_KEY}` } : {};
  const erc721 = await getJson(`${base}/tokens`, {
    params: { type: 'ERC-721' },
    headers,
    silent: true
  });
  const erc1155 = await getJson(`${base}/tokens`, {
    params: { type: 'ERC-1155' },
    headers,
    silent: true
  });
  const items = [
    ...(erc721?.items || erc721?.results || []),
    ...(erc1155?.items || erc1155?.results || [])
  ];
  return items;
}

async function collectRhMints() {
  const bases = [CHAINS.robinhood.blockscout, CHAINS.robinhood.blockscoutAlt].filter(Boolean);
  let tokens = [];
  for (const base of bases) {
    tokens = await recentTokens(base);
    if (tokens.length) {
      log(`RH Blockscout tokens via ${base}: ${tokens.length}`);
      break;
    }
  }
  if (!tokens.length) {
    log('RH mint collector: no token list (endpoint missing or empty)');
    return [];
  }

  const cutoff = Date.now() - FIRST_MINT_HOURS * 36e5;
  const out = [];
  for (const t of tokens.slice(0, 40)) {
    const address = t.address_hash || t.address || t.hash;
    if (!address) continue;
    const type = String(t.type || '').toUpperCase();
    if (type && !type.includes('ERC-721') && !type.includes('ERC-1155') && !type.includes('NFT')) {
      continue;
    }
    const created = t.created_at ? new Date(t.created_at).getTime() : Date.now();
    if (Number.isFinite(created) && created < cutoff && t.holders_count > 40) continue;

    out.push({
      name: t.name || t.symbol || `RH ${String(address).slice(0, 8)}`,
      chain: 'robinhood',
      slug: String(t.name || address)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 60),
      contractAddress: String(address).toLowerCase(),
      url: `https://opensea.io/assets/robinhood/${address}`,
      explorerUrl: explorerUrl('robinhood', address),
      twitterUrl: null,
      mintUrl: null,
      siteUrl: null,
      discordUrl: null,
      image: t.icon_url || null,
      description: null,
      deployer: null,
      verified: null,
      isMinting: true,
      mintedOut: false,
      stages: [{ label: 'RH on-chain', start_time: new Date(created).toISOString() }],
      maxSupply: t.total_supply ? Number(t.total_supply) : null,
      totalSupply: t.holders_count ? Number(t.holders_count) : null,
      uniqueMinters: t.holders_count != null ? Number(t.holders_count) : null,
      uniqueHolders: t.holders_count != null ? Number(t.holders_count) : null,
      topHolderPct: null,
      deployerMintPct: null,
      minters1h: null,
      minters6h: null,
      minters24h: t.holders_count != null ? Number(t.holders_count) : null,
      priceEth: null,
      priceLabel: 'On-chain',
      source: 'rh-blockscout',
      firstMintAt: new Date(created).toISOString(),
      createdAt: new Date(created).toISOString(),
      hasMetadata: Boolean(t.icon_url || t.name),
      hasRoyalty: false
    });
  }
  return out;
}

module.exports = { collectRhMints };
