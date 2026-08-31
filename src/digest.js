const { TZ } = require('./config');

function shortAddr(addr) {
  if (!addr) return 'n/a';
  const a = String(addr);
  if (a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function chainTag(chain) {
  return chain === 'robinhood' ? 'RH' : 'ETH';
}

function formatPt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  });
}

function statusLine(c) {
  if (c.mintedOut) return 'ENDING';
  if (c.isMinting) return 'LIVE';
  const next = (c.stages || []).find(s => s.start_time && new Date(s.start_time) > new Date());
  const t = formatPt(next?.start_time);
  return t ? `STARTS ${t} PT` : 'STARTS SOON';
}

function supplyLine(c) {
  const minted = c.totalSupply != null ? c.totalSupply : '?';
  const max = c.maxSupply != null ? c.maxSupply : '?';
  return `${minted}/${max}`;
}

function linkParts(c) {
  const parts = [];
  if (c.url) parts.push(`[OpenSea](${c.url})`);
  if (c.explorerUrl) parts.push(`[Explorer](${c.explorerUrl})`);
  if (c.twitterUrl) parts.push(`[X](${c.twitterUrl})`);
  if (c.mintUrl && c.mintUrl !== c.url) parts.push(`[Mint](${c.mintUrl})`);
  return parts.join(' | ') || 'n/a';
}

function formatDateHeader(date = new Date()) {
  return date.toLocaleDateString('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function itemBlock(c, i, { boldName = false } = {}) {
  const title = boldName ? `**${i + 1}. ${c.name}**` : `${i + 1}. ${c.name}`;
  return [
    title,
    `   Chain: ${chainTag(c.chain)}`,
    `   Status: ${statusLine(c)}`,
    `   Price: ${c.priceLabel || 'TBD'} | Supply: ${supplyLine(c)}`,
    `   Why: ${c.why}`,
    `   Links: ${linkParts(c)}`,
    `   Contract: ${shortAddr(c.contractAddress)}`
  ].join('\n');
}

function formatDigest(items, { date } = {}) {
  const headerDate = formatDateHeader(date);
  if (!items.length) {
    return {
      content: `**GM ALPHA — ${headerDate} — ETH + ROBINHOOD**\nNo high-quality new mints cleared filters today. Watching.`,
      text: `GM ALPHA — ${headerDate} — ETH + ROBINHOOD\nNo high-quality new mints cleared filters today. Watching.`
    };
  }

  const text = [
    `GM ALPHA — ${headerDate} — ETH + ROBINHOOD`,
    `${items.length} mint${items.length === 1 ? '' : 's'} worth looking at. Ranked.`,
    '',
    items.map((c, i) => itemBlock(c, i, { boldName: false })).join('\n\n')
  ].join('\n');

  const content = [
    `**GM ALPHA — ${headerDate} — ETH + ROBINHOOD**`,
    `${items.length} mint${items.length === 1 ? '' : 's'} worth looking at. Ranked.`,
    '',
    items.map((c, i) => itemBlock(c, i, { boldName: true })).join('\n\n')
  ].join('\n');

  return { content, text };
}

module.exports = { formatDigest, formatDateHeader, shortAddr, statusLine };
