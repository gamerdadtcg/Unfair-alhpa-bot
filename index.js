require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const OPENSEA_HEADERS = {
  Accept: 'application/json',
  'X-API-KEY': process.env.OPENSEA_API_KEY || ''
};

const ALLOWED_CHAINS = new Set(['ethereum', 'robinhood']);
const EMBEDS_PER_MESSAGE = 10;
const MAX_OPENSEA_PAGES = 5;

// ---------- Helpers ----------
function pacificNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function isToday(isoString) {
  if (!isoString) return false;
  const d = new Date(isoString);
  const today = pacificNow();
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  );
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

function isSoldOut(drop) {
  const max = Number(drop.max_supply || drop.maxSupply || 0);
  const total = Number(drop.total_supply || drop.totalSupply || 0);
  if (max > 0 && total >= max) return true;

  const stages = drop.stages || [];
  if (stages.length === 0) return false;

  const hasActiveStage = stages.some(s => {
    const now = Date.now();
    const start = s.start_time ? new Date(s.start_time).getTime() : 0;
    const end = s.end_time ? new Date(s.end_time).getTime() : Infinity;
    return now >= start && now <= end;
  });

  return !hasActiveStage && total > 0;
}

function stageIsRelevant(stage) {
  if (!stage) return false;
  const now = Date.now();
  const start = stage.start_time ? new Date(stage.start_time).getTime() : null;
  const end = stage.end_time ? new Date(stage.end_time).getTime() : Infinity;
  const startsToday = start && isToday(stage.start_time);
  const isActive = start && start <= now && now <= end;
  return Boolean(startsToday || isActive);
}

function dropIsMintingToday(drop) {
  if (drop.is_minting === true) return true;

  const stages = [
    drop.active_stage,
    drop.next_stage,
    ...(drop.stages || [])
  ].filter(Boolean);

  if (stages.some(stageIsRelevant)) return true;

  if (stages.length === 0) {
    const max = Number(drop.max_supply || drop.maxSupply || Infinity);
    const total = Number(drop.total_supply || drop.totalSupply || 0);
    return total < max;
  }

  return false;
}

function formatPrice(stage) {
  if (!stage || stage.price == null || stage.price === '') return 'Free / TBD';
  const wei = Number(stage.price);
  if (!Number.isFinite(wei) || wei === 0) return 'Free';
  return `${(wei / 1e18).toFixed(4)} ETH`;
}

function formatSupply(drop) {
  if (drop.maxSupply == null && drop.max_supply == null) return 'Check site';
  const total = drop.totalSupply ?? drop.total_supply ?? 0;
  const max = drop.maxSupply ?? drop.max_supply;
  return `${total} / ${max}`;
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
  const stages = (drop.stages || []).filter(Boolean);
  const relevant = stages.filter(stageIsRelevant);
  return {
    name: drop.collection_name || drop.name,
    chain: chainOf(drop) || 'ethereum',
    slug: drop.collection_slug || drop.slug,
    url: drop.opensea_url || drop.url || `https://opensea.io/collection/${drop.collection_slug || drop.slug}`,
    image: drop.image_url || drop.image || null,
    maxSupply: drop.max_supply ?? drop.maxSupply ?? null,
    totalSupply: drop.total_supply ?? drop.totalSupply ?? null,
    stages: relevant.length > 0 ? relevant : stages.slice(0, 1),
    source: drop.source || 'opensea'
  };
}

function sortDrops(drops) {
  return [...drops].sort((a, b) => {
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

// ---------- OpenSea ----------
async function fetchOpenSeaPages(type, chains) {
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
      console.log(`OpenSea ${type} / ${chains} failed:`, err.message);
      break;
    }
  } while (cursor && pages < MAX_OPENSEA_PAGES);

  return drops;
}

async function enrichOpenSeaDrop(drop) {
  try {
    const detail = await axios.get(
      `https://api.opensea.io/api/v2/drops/${drop.collection_slug}`,
      { headers: OPENSEA_HEADERS, timeout: 10000 }
    );
    return { ...drop, ...detail.data, source: drop.source };
  } catch (err) {
    return drop;
  }
}

async function fetchOpenSeaDrops() {
  const chainAttempts = ['ethereum,robinhood', 'ethereum', 'robinhood'];
  const types = ['upcoming', 'featured', 'recently_minted'];
  const resultsMap = new Map();

  for (const chains of chainAttempts) {
    for (const type of types) {
      const drops = await fetchOpenSeaPages(type, chains);
      for (const drop of drops) {
        const slug = drop.collection_slug;
        if (!slug || resultsMap.has(slug)) continue;
        if (!isAllowedChain(drop.chain)) continue;
        resultsMap.set(slug, { ...drop, source: `opensea-${type}` });
      }
    }
  }

  const enriched = await mapPool([...resultsMap.values()], 5, enrichOpenSeaDrop);
  const kept = [];

  for (const drop of enriched) {
    if (!isAllowedChain(drop.chain)) continue;
    if (!dropIsMintingToday(drop)) continue;
    if (isSoldOut(drop)) continue;
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
          text.includes('minting now');

        if (!mentionsToday) return;

        const slugGuess = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 60);

        if (existingSlugs.has(slugGuess) || results.some(r => r.slug === slugGuess)) return;

        results.push({
          name: title,
          chain,
          slug: slugGuess,
          url: link.startsWith('http') ? link : `https://nftcalendar.io${link}`,
          image: container.find('img').attr('src') || container.find('img').attr('data-src') || null,
          maxSupply: null,
          totalSupply: null,
          stages: [{ label: 'Check site / Live', start_time: new Date().toISOString(), price: null }],
          source: 'nftcalendar'
        });
      });
    } catch (err) {
      console.log(`nftcalendar scrape failed (${page.url}):`, err.message);
    }
  }

  return results;
}

// ---------- Combine ----------
async function getTodaysMints() {
  const openSea = await fetchOpenSeaDrops();
  const existing = new Set(openSea.map(d => d.slug));
  const fallback = await fetchNftCalendarFallback(existing);
  return sortDrops([...openSea, ...fallback]);
}

// ---------- Embeds: one compact list with small thumbnails ----------
function buildListEmbeds(drops) {
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
          text: `${drops.length} projects · 🟢 Robinhood ${rhCount} · 🟣 Ethereum ${ethCount}`
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
    .setColor(isRobinhood(drop) ? 0x00c805 : 0x627eea)
    .setDescription(
      `**${chainLabel(drop)}** · ${formatSupply(drop)} · ${formatPrice(stage)}\n${stage?.label || stage?.stage_type || 'Mint'} · ${formatStart(stage)} PST`
    )
    .setFooter({ text: `Source: ${drop.source}` });

  if (drop.image) embed.setThumbnail(drop.image);
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
    if (isSlash) {
      if (i === 0) await channel.editReply(payload);
      else await channel.followUp(payload);
    } else {
      await channel.send(payload);
    }
  }
}

// ---------- Post ----------
async function postDrops(channel, isSlash = false) {
  const drops = await getTodaysMints();

  if (drops.length === 0) {
    const msg = 'No active ETH or Robinhood Chain mints found right now.';
    if (isSlash) return channel.editReply({ content: msg });
    return channel.send(msg);
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
}

// ---------- Slash Command ----------
const commands = [
  new SlashCommandBuilder()
    .setName('drops')
    .setDescription("Show today's ETH + Robinhood NFT mints")
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log('Slash commands registered');
}

// ---------- Events ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'drops') {
    await interaction.deferReply();
    await postDrops(interaction, true);
  }
});

// ---------- Daily at 12:00 AM PST ----------
cron.schedule(
  '0 0 * * *',
  async () => {
    console.log('Running daily mint alert...');
    try {
      const channel = await client.channels.fetch(process.env.CHANNEL_ID);
      await postDrops(channel, false);
    } catch (err) {
      console.error('Daily post failed:', err);
    }
  },
  { timezone: 'America/Los_Angeles' }
);

client.login(process.env.DISCORD_TOKEN);
