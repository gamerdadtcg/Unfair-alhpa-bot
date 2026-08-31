const { CHAINS, BLOCKSCOUT_KEY } = require('./config');
const { getJson } = require('./http');

async function explorerVerified(chain, address) {
  if (!address) return null;
  const info = CHAINS[chain];
  if (!info) return null;
  const headers = BLOCKSCOUT_KEY ? { Authorization: `Bearer ${BLOCKSCOUT_KEY}` } : {};
  const bases = [info.blockscout, info.blockscoutAlt].filter(Boolean);
  for (const base of bases) {
    const data = await getJson(`${base}/smart-contracts/${address}`, { headers, silent: true });
    if (data && (data.is_verified || data.is_fully_verified)) return true;
    if (data && data.is_verified === false) return false;
  }
  return null;
}

async function tokenStats(chain, address) {
  const info = CHAINS[chain];
  if (!info || !address) return {};
  const headers = BLOCKSCOUT_KEY ? { Authorization: `Bearer ${BLOCKSCOUT_KEY}` } : {};
  const data = await getJson(`${info.blockscout}/tokens/${address}`, { headers, silent: true });
  if (!data) return {};
  return {
    uniqueHolders: data.holders_count != null ? Number(data.holders_count) : null,
    totalSupply: data.total_supply != null ? Number(data.total_supply) : null,
    name: data.name || null,
    image: data.icon_url || null,
    tokenType: data.type || null
  };
}

async function enrichCandidate(c) {
  const verified = c.verified != null ? c.verified : await explorerVerified(c.chain, c.contractAddress);
  const stats = c.contractAddress ? await tokenStats(c.chain, c.contractAddress) : {};
  const type = String(stats.tokenType || '').toUpperCase();
  if (type && !type.includes('ERC-721') && !type.includes('ERC-1155') && !type.includes('NFT')) {
    return { ...c, skipNonNft: true };
  }
  return {
    ...c,
    verified: verified,
    uniqueHolders: c.uniqueHolders ?? stats.uniqueHolders,
    totalSupply: c.totalSupply ?? stats.totalSupply,
    name: c.name || stats.name,
    image: c.image || stats.image,
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
