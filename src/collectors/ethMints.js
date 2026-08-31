const { CHAINS, ZERO_ADDRESS, FIRST_MINT_HOURS } = require('../config');
const { getJson, rpc } = require('../http');
const { log } = require('../log');
const { explorerUrl } = require('./opensea');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';

function padAddress(addr) {
  return `0x${String(addr).slice(2).toLowerCase().padStart(64, '0')}`;
}

function topicToAddress(topic) {
  if (!topic) return null;
  return `0x${String(topic).slice(-40).toLowerCase()}`;
}

function isAlchemy(url) {
  return /alchemy\.com/i.test(url || '');
}

async function alchemyMints(rpcUrl, hours) {
  const transfers = [];
  let pageKey;
  for (let i = 0; i < 4; i++) {
    const params = {
      fromBlock: '0x0',
      toBlock: 'latest',
      fromAddress: ZERO_ADDRESS,
      category: ['erc721', 'erc1155'],
      excludeZeroValue: false,
      maxCount: '0x3e8',
      withMetadata: true,
      order: 'desc'
    };
    if (pageKey) params.pageKey = pageKey;
    const result = await rpc(rpcUrl, 'alchemy_getAssetTransfers', [params]);
    if (!result?.transfers) break;
    transfers.push(...result.transfers);
    pageKey = result.pageKey;
    if (!pageKey) break;
  }

  const cutoff = Date.now() - hours * 36e5;
  const byContract = new Map();
  for (const t of transfers) {
    const contract = (t.rawContract?.address || t.contractAddress || '').toLowerCase();
    if (!contract) continue;
    const ts = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : Date.now();
    if (ts < cutoff) continue;
    const rec = byContract.get(contract) || {
      address: contract,
      firstMintAt: ts,
      minters: new Set(),
      count: 0
    };
    rec.firstMintAt = Math.min(rec.firstMintAt, ts);
    if (t.to) rec.minters.add(String(t.to).toLowerCase());
    rec.count += 1;
    byContract.set(contract, rec);
  }
  return [...byContract.values()];
}

async function logMints(rpcUrl, hours) {
  if (!rpcUrl) return [];
  const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
  const latest = parseInt(latestHex, 16);
  if (!Number.isFinite(latest)) return [];
  const blocks = Math.min(8000, Math.floor((hours * 3600) / 12));
  const fromBlock = Math.max(0, latest - blocks);
  const logs = await rpc(rpcUrl, 'eth_getLogs', [
    {
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: 'latest',
      topics: [TRANSFER_TOPIC, padAddress(ZERO_ADDRESS)]
    }
  ]);
  if (!Array.isArray(logs)) return [];
  const byContract = new Map();
  for (const row of logs) {
    const contract = String(row.address || '').toLowerCase();
    const to = topicToAddress(row.topics?.[2]);
    const rec = byContract.get(contract) || {
      address: contract,
      firstMintAt: Date.now(),
      minters: new Set(),
      count: 0
    };
    rec.count += 1;
    if (to) rec.minters.add(to);
    byContract.set(contract, rec);
  }
  return [...byContract.values()];
}

async function blockscoutToken(base, address, apiKey) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  return getJson(`${base}/tokens/${address}`, { headers, silent: true, timeout: 10000 });
}

async function collectEthMints() {
  const rpcUrl = CHAINS.ethereum.rpc;
  if (!rpcUrl) {
    log('ETH RPC missing, skipping on-chain mint collector');
    return [];
  }

  let groups = [];
  try {
    groups = isAlchemy(rpcUrl)
      ? await alchemyMints(rpcUrl, FIRST_MINT_HOURS)
      : await logMints(rpcUrl, FIRST_MINT_HOURS);
  } catch (err) {
    log(`ETH mint collector failed: ${err.message}`);
    return [];
  }

  log(`ETH on-chain mint contracts (24h window): ${groups.length}`);
  const out = [];
  for (const g of groups.slice(0, 40)) {
    const token = await blockscoutToken(CHAINS.ethereum.blockscout, g.address, process.env.BLOCKSCOUT_KEY);
    const type = String(token?.type || '').toUpperCase();
    if (token && type && !type.includes('ERC-721') && !type.includes('ERC-1155')) continue;
    out.push({
      name: token?.name || `Unnamed ${g.address.slice(0, 8)}`,
      chain: 'ethereum',
      slug: (token?.name || g.address).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60),
      contractAddress: g.address,
      url: `https://opensea.io/assets/ethereum/${g.address}`,
      explorerUrl: explorerUrl('ethereum', g.address),
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
      uniqueMinters: g.minters.size,
      uniqueHolders: token?.holders_count != null ? Number(token.holders_count) : g.minters.size,
      topHolderPct: null,
      deployerMintPct: null,
      minters1h: null,
      minters6h: null,
      minters24h: g.minters.size,
      priceEth: null,
      priceLabel: 'On-chain',
      source: 'eth-mint-logs',
      firstMintAt: new Date(g.firstMintAt).toISOString(),
      createdAt: new Date(g.firstMintAt).toISOString(),
      hasMetadata: Boolean(token?.icon_url),
      hasRoyalty: false
    });
  }
  return out;
}

module.exports = { collectEthMints, TRANSFER_TOPIC, TRANSFER_SINGLE };
