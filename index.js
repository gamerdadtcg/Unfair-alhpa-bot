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
const MAX_OPENSEA_PAGES = 8;
const RECENT_START_HOURS = 48;
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
  if (drop.is_minting === true) return true;
  if (isToday(drop.created_date) || isWithinHours(drop.created_date, RECENT_START_HOURS)) {
    return true;
  }

  const stages = allStages(drop);
  const recentlyMinted = String(drop.source || '').includes('recently_minted');
  const soldOut = isSoldOut(drop);

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
    source: drop.source || 'opensea'
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
      console.log(`OpenSea ${type} / ${chains} failed:`, err.message);
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
    created_date: collection.created_date
  };
}

async function fetchOpenSeaDrops() {
  const chainAttempts = ['ethereum,robinhood', 'ethereum', 'robinhood'];
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
  return sortDrops([...openSea, ...fallback].filter(drop => !isOrangeHare(drop)));
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
