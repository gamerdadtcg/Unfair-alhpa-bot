const { ZERO_ADDRESS, FIRST_MINT_HOURS } = require('../config');
const { rpc } = require('../http');
const { log } = require('../log');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const TRANSFER_BATCH = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

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

function emptyGroup(contract, ts) {
  return {
    address: contract,
    firstMintAt: ts,
    events: []
  };
}

function addMint(map, contract, to, ts) {
  if (!contract) return;
  const rec = map.get(contract) || emptyGroup(contract, ts);
  rec.firstMintAt = Math.min(rec.firstMintAt, ts);
  rec.events.push({ to: to ? String(to).toLowerCase() : null, ts });
  map.set(contract, rec);
}

function summarizeGroup(g, now = Date.now()) {
  const minters = new Set();
  const m1 = new Set();
  const m6 = new Set();
  const m24 = new Set();
  const h1 = now - 36e5;
  const h6 = now - 6 * 36e5;
  const h24 = now - 24 * 36e5;
  for (const e of g.events) {
    if (!e.to) continue;
    minters.add(e.to);
    if (e.ts >= h1) m1.add(e.to);
    if (e.ts >= h6) m6.add(e.to);
    if (e.ts >= h24) m24.add(e.to);
  }
  return {
    address: g.address,
    firstMintAt: g.firstMintAt,
    count: g.events.length,
    uniqueMinters: minters.size,
    minters1h: m1.size,
    minters6h: m6.size,
    minters24h: m24.size,
    minters: minters
  };
}

async function recentFromBlock(rpcUrl, hours, secondsPerBlock = 12) {
  const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
  const latest = parseInt(latestHex, 16);
  if (!Number.isFinite(latest)) return null;
  const span = Math.min(12000, Math.floor((hours * 3600) / secondsPerBlock));
  return { latest, fromBlock: Math.max(0, latest - span) };
}

async function alchemyMints(rpcUrl, hours) {
  const range = await recentFromBlock(rpcUrl, hours);
  const fromBlock = range ? `0x${range.fromBlock.toString(16)}` : '0x0';
  const transfers = [];
  let pageKey;
  for (let i = 0; i < 4; i++) {
    const params = {
      fromBlock,
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
    const ts = t.metadata?.blockTimestamp
      ? new Date(t.metadata.blockTimestamp).getTime()
      : Date.now();
    if (!contract || ts < cutoff) continue;
    addMint(byContract, contract, t.to, ts);
  }
  return [...byContract.values()].map(g => summarizeGroup(g));
}

async function fetchLogs(rpcUrl, fromBlock, topics) {
  const logs = await rpc(rpcUrl, 'eth_getLogs', [
    {
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: 'latest',
      topics
    }
  ]);
  return Array.isArray(logs) ? logs : [];
}

async function logMints(rpcUrl, hours, secondsPerBlock = 12) {
  if (!rpcUrl) return [];
  const range = await recentFromBlock(rpcUrl, hours, secondsPerBlock);
  if (!range) return [];
  const from = padAddress(ZERO_ADDRESS);
  const now = Date.now();
  const [erc721, erc1155, erc1155Batch] = await Promise.all([
    fetchLogs(rpcUrl, range.fromBlock, [TRANSFER_TOPIC, from]),
    fetchLogs(rpcUrl, range.fromBlock, [TRANSFER_SINGLE, null, from]),
    fetchLogs(rpcUrl, range.fromBlock, [TRANSFER_BATCH, null, from])
  ]);

  const byContract = new Map();
  for (const row of erc721) {
    addMint(byContract, String(row.address || '').toLowerCase(), topicToAddress(row.topics?.[2]), now);
  }
  for (const row of [...erc1155, ...erc1155Batch]) {
    addMint(byContract, String(row.address || '').toLowerCase(), topicToAddress(row.topics?.[3]), now);
  }
  return [...byContract.values()].map(g => summarizeGroup(g, now));
}

async function collectMintGroups(rpcUrl, { hours = FIRST_MINT_HOURS, secondsPerBlock = 12, label } = {}) {
  if (!rpcUrl) return [];
  try {
    const groups = isAlchemy(rpcUrl)
      ? await alchemyMints(rpcUrl, hours)
      : await logMints(rpcUrl, hours, secondsPerBlock);
    log(`${label || 'on-chain'} mint contracts (${hours}h): ${groups.length}`);
    return groups;
  } catch (err) {
    log(`${label || 'on-chain'} mint collector failed: ${err.message}`);
    return [];
  }
}

module.exports = {
  collectMintGroups,
  summarizeGroup,
  TRANSFER_TOPIC,
  TRANSFER_SINGLE,
  TRANSFER_BATCH,
  isAlchemy
};
