const { CHAINS, FIRST_MINT_HOURS, BLOCKSCOUT_KEY } = require('../config');
const { getJson } = require('../http');
const { log } = require('../log');
const { explorerUrl } = require('./opensea');
const { collectMintGroups, TRANSFER_TOPIC, TRANSFER_SINGLE } = require('./mintLogs');

async function blockscoutToken(base, address, apiKey) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  return getJson(`${base}/tokens/${address}`, { headers, silent: true, timeout: 10000 });
}

function candidateFromGroup(chain, g, token) {
  const type = String(token?.type || '').toUpperCase();
  if (token && type && !type.includes('ERC-721') && !type.includes('ERC-1155') && !type.includes('NFT')) {
    return null;
  }
  const osChain = chain === 'robinhood' ? 'robinhood' : 'ethereum';
  return {
    name: token?.name || `Unnamed ${g.address.slice(0, 8)}`,
    chain,
    slug: (token?.name || g.address).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60),
    contractAddress: g.address,
    url: `https://opensea.io/assets/${osChain}/${g.address}`,
    explorerUrl: explorerUrl(chain, g.address),
    twitterUrl: null,
    mintUrl: null,
    siteUrl: null,
    discordUrl: null,
    image: token?.icon_url || null,
    description: null,
    deployer: null,
    verified: null,
    isMinting: true,
    mintedOut: false,
    stages: [{ label: 'On-chain mints', start_time: new Date(g.firstMintAt).toISOString() }],
    maxSupply: token?.total_supply ? Number(token.total_supply) : null,
    totalSupply: g.count,
    uniqueMinters: g.uniqueMinters,
    uniqueHolders: token?.holders_count != null ? Number(token.holders_count) : g.uniqueMinters,
    topHolderPct: null,
    deployerMintPct: null,
    minters1h: g.minters1h,
    minters6h: g.minters6h,
    minters24h: g.minters24h,
    priceEth: null,
    priceLabel: 'On-chain',
    source: chain === 'robinhood' ? 'rh-mint-logs' : 'eth-mint-logs',
    firstMintAt: new Date(g.firstMintAt).toISOString(),
    createdAt: new Date(g.firstMintAt).toISOString(),
    hasMetadata: Boolean(token?.icon_url),
    hasRoyalty: false
  };
}

async function collectOnchainMints(chain) {
  const info = CHAINS[chain];
  if (!info?.rpc) {
    log(`${info?.label || chain} RPC missing, skipping on-chain mint collector`);
    return [];
  }

  const groups = await collectMintGroups(info.rpc, {
    hours: FIRST_MINT_HOURS,
    label: `${info.label} on-chain`
  });

  const out = [];
  for (const g of groups.slice(0, 40)) {
    const token = await blockscoutToken(info.blockscout, g.address, BLOCKSCOUT_KEY);
    const candidate = candidateFromGroup(chain, g, token);
    if (candidate) out.push(candidate);
  }
  return out;
}

async function collectEthMints() {
  return collectOnchainMints('ethereum');
}

module.exports = {
  collectEthMints,
  collectOnchainMints,
  candidateFromGroup,
  TRANSFER_TOPIC,
  TRANSFER_SINGLE
};
