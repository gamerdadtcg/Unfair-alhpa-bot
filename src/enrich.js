const { CHAINS, BLOCKSCOUT_KEY } = require('./config');
const { getJson, rpc } = require('./http');

const ROYALTY_INFO = '0x2a55205a';

function headers() {
  return BLOCKSCOUT_KEY ? { Authorization: `Bearer ${BLOCKSCOUT_KEY}` } : {};
}

async function explorerVerified(chain, address) {
  if (!address) return null;
  const info = CHAINS[chain];
  if (!info) return null;
  const bases = [info.blockscout, info.blockscoutAlt].filter(Boolean);
  for (const base of bases) {
    const data = await getJson(`${base}/smart-contracts/${address}`, { headers: headers(), silent: true });
    if (data && (data.is_verified || data.is_fully_verified)) return true;
    if (data && data.is_verified === false) return false;
  }
  return null;
}

async function tokenStats(chain, address) {
  const info = CHAINS[chain];
  if (!info || !address) return {};
  const data = await getJson(`${info.blockscout}/tokens/${address}`, { headers: headers(), silent: true });
  if (!data) return {};
  return {
    uniqueHolders: data.holders_count != null ? Number(data.holders_count) : null,
    totalSupply: data.total_supply != null ? Number(data.total_supply) : null,
    name: data.name || null,
    image: data.icon_url || null,
    tokenType: data.type || null
  };
}

async function holderConcentration(chain, address, totalSupply) {
  const info = CHAINS[chain];
  if (!info || !address) return {};
  const data = await getJson(`${info.blockscout}/tokens/${address}/holders`, {
    headers: headers(),
    silent: true,
    timeout: 10000
  });
  const items = data?.items || data?.holders || [];
  if (!items.length) return {};
  const supply = Number(totalSupply || 0);
  const topVal = Number(items[0]?.value ?? items[0]?.token?.value ?? 0);
  const topHolderPct = supply > 0 && Number.isFinite(topVal) ? (topVal / supply) * 100 : null;
  return { topHolderPct, holderRows: items };
}

async function contractCreator(chain, address) {
  const info = CHAINS[chain];
  if (!info || !address) return null;
  const data = await getJson(`${info.blockscout}/addresses/${address}`, {
    headers: headers(),
    silent: true
  });
  return data?.creator_address_hash || data?.creator_address || null;
}

async function hasErc2981(chain, address) {
  const rpcUrl = CHAINS[chain]?.rpc;
  if (!rpcUrl || !address) return null;
  const data =
    ROYALTY_INFO +
    '0'.padStart(64, '0') +
    (10n ** 18n).toString(16).padStart(64, '0');
  const result = await rpc(rpcUrl, 'eth_call', [{ to: address, data }, 'latest']);
  if (result == null) return null;
  if (result === '0x' || result === '0x0') return false;
  return String(result).length > 2;
}

function deployerShare(deployer, holderRows, totalSupply) {
  if (!deployer || !holderRows?.length || !totalSupply) return null;
  const want = String(deployer).toLowerCase();
  const row = holderRows.find(h => {
    const addr = h.address?.hash || h.address || h.hash;
    return String(addr || '').toLowerCase() === want;
  });
  if (!row) return 0;
  const val = Number(row.value ?? 0);
  if (!Number.isFinite(val)) return null;
  return (val / Number(totalSupply)) * 100;
}

async function enrichCandidate(c) {
  const verified = c.verified != null ? c.verified : await explorerVerified(c.chain, c.contractAddress);
  const stats = c.contractAddress ? await tokenStats(c.chain, c.contractAddress) : {};
  const type = String(stats.tokenType || '').toUpperCase();
  if (type && !type.includes('ERC-721') && !type.includes('ERC-1155') && !type.includes('NFT')) {
    return { ...c, skipNonNft: true };
  }

  const supply = c.totalSupply ?? stats.totalSupply;
  const [holders, creator, royalty] = await Promise.all([
    c.topHolderPct == null && c.contractAddress
      ? holderConcentration(c.chain, c.contractAddress, supply)
      : Promise.resolve({}),
    c.deployer || !c.contractAddress ? Promise.resolve(c.deployer) : contractCreator(c.chain, c.contractAddress),
    c.hasRoyalty || !c.contractAddress ? Promise.resolve(c.hasRoyalty) : hasErc2981(c.chain, c.contractAddress)
  ]);

  const deployer = c.deployer || creator || null;
  const deployerMintPct =
    c.deployerMintPct != null
      ? c.deployerMintPct
      : deployerShare(deployer, holders.holderRows, supply);

  return {
    ...c,
    verified,
    uniqueHolders: c.uniqueHolders ?? stats.uniqueHolders,
    totalSupply: supply,
    name: c.name || stats.name,
    image: c.image || stats.image,
    deployer,
    topHolderPct: c.topHolderPct ?? holders.topHolderPct ?? null,
    deployerMintPct,
    hasRoyalty: royalty === true ? true : c.hasRoyalty,
    hasMetadata: c.hasMetadata || Boolean(stats.image || c.image || c.description)
  };
}

async function enrichAll(candidates) {
  const out = [];
  for (let i = 0; i < candidates.length; i += 4) {
    const batch = candidates.slice(i, i + 4);
    const done = await Promise.all(batch.map(enrichCandidate));
    out.push(...done.filter(c => !c.skipNonNft));
  }
  return out;
}

module.exports = { enrichAll, explorerVerified, tokenStats };
