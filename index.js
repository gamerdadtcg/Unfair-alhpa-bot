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

// ---------- Helpers ----------
function isToday(isoString) {
  if (!isoString) return false;
  const d = new Date(isoString);
  const today = new Date();
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  );
}

function isSoldOut(drop) {
  const max = Number(drop.max_supply || 0);
  const total = Number(drop.total_supply || 0);
  if (max > 0 && total >= max) return true;

  const hasActiveStage = (drop.stages || []).some(s => {
    const now = Date.now();
    const start = s.start_time ? new Date(s.start_time).getTime() : 0;
    const end = s.end_time ? new Date(s.end_time).getTime() : Infinity;
    return now >= start && now <= end;
  });

  return !hasActiveStage && total > 0;
}

// ---------- OpenSea (improved) ----------
async function fetchOpenSeaDrops() {
  const chainAttempts = ['ethereum,robinhood', 'ethereum', 'robinhood'];
  const types = ['upcoming', 'featured', 'recently_minted'];
  const resultsMap = new Map();

  for (const chains of chainAttempts) {
    for (const type of types) {
      try {
        const res = await axios.get('https://api.opensea.io/api/v2/drops', {
          params: {
            type,
            chains,
            limit: 50
          },
          headers: OPENSEA_HEADERS
        });

        const drops = res.data.drops || [];

        for (const drop of drops) {
          if (resultsMap.has(drop.collection_slug)) continue;

          try {
            const detail = await axios.get(
              `https://api.opensea.io/api/v2/drops/${drop.collection_slug}`,
              { headers: OPENSEA_HEADERS }
            );
            const d = detail.data;

            const stages = d.stages || [];
            const now = Date.now();

            // Loosened filter
            const relevantStages = stages.filter(s => {
              const start = s.start_time ? new Date(s.start_time).getTime() : null;
              const end = s.end_time ? new Date(s.end_time).getTime() : Infinity;

              const startsToday = start && isToday(s.start_time);
              const isActive = start && start <= now && now <= end;
              return startsToday || isActive;
            });

            const keep =
              relevantStages.length > 0 ||
              d.is_minting === true ||
              (stages.length === 0 && (d.total_supply || 0) < (d.max_supply || Infinity));

            if (!keep) continue;
            if (isSoldOut(d)) continue;

            resultsMap.set(d.collection_slug, {
              name: d.collection_name || drop.collection_name,
              chain: (d.chain || drop.chain || 'unknown').toLowerCase(),
              slug: d.collection_slug,
              url: d.opensea_url || `https://opensea.io/collection/${d.collection_slug}`,
              image: d.image_url || null,
              maxSupply: d.max_supply,
              totalSupply: d.total_supply,
              stages: relevantStages.length > 0 ? relevantStages : stages.slice(0, 2),
              source: `opensea-${type}`
            });
          } catch (e) {
            // skip individual errors
          }
        }
      } catch (err) {
        console.log(`OpenSea ${type} / ${chains} failed:`, err.message);
      }
    }
  }

  return Array.from(resultsMap.values());
}

// ---------- Stronger nftcalendar scrape ----------
async function fetchNftCalendarFallback(existingSlugs = new Set()) {
  const results = [];
  const urls = [
    'https://nftcalendar.io/',
    'https://nftcalendar.io/b/robinhood/',
    'https://nftcalendar.io/b/ethereum/'
  ];

  for (const url of urls) {
    try {
      const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NFTBot/1.0)' },
        timeout: 10000
      });
      const $ = cheerio.load(data);

      $('h2, h3, .event-title, .drop-title, article h2').each((_, el) => {
        const title = $(el).text().trim();
        if (!title || title.length < 4) return;

        const container = $(el).closest('article, .event, .drop, div').length
          ? $(el).closest('article, .event, .drop, div')
          : $(el).parent();

        const text = (container.text() || '').toLowerCase();
        const link = container.find('a').attr('href') || $(el).find('a').attr('href') || '';

        const isRobinhood = text.includes('robinhood') || url.includes('robinhood');
        const isEth = text.includes('ethereum') || text.includes(' eth ') || url.includes('ethereum');
        if (!isRobinhood && !isEth) return;

        const mentionsToday =
          text.includes('aug 14') ||
          text.includes('august 14') ||
          text.includes('today') ||
          text.includes('minting now') ||
          text.includes('live') ||
          url.includes('robinhood');

        if (!mentionsToday) return;

        const slugGuess = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 60);

        if (existingSlugs.has(slugGuess) || results.some(r => r.slug === slugGuess)) return;

        results.push({
          name: title,
          chain: isRobinhood ? 'robinhood' : 'ethereum',
          slug: slugGuess,
          url: link.startsWith('http') ? link : `https://nftcalendar.io${link}`,
          image: container.find('img').attr('src') || null,
          maxSupply: null,
          totalSupply: null,
          stages: [{ label: 'Check site / Live', start_time: new Date().toISOString(), price: null }],
          source: 'nftcalendar'
        });
      });
    } catch (err) {
      console.log(`nftcalendar scrape failed (${url}):`, err.message);
    }
  }

  return results.slice(0, 15);
}

// ---------- Combine ----------
async function getTodaysMints() {
  const openSea = await fetchOpenSeaDrops();
  const existing = new Set(openSea.map(d => d.slug));
  const fallback = await fetchNftCalendarFallback(existing);
  return [...openSea, ...fallback];
}

// ---------- Embed ----------
function buildEmbed(drop) {
  const embed = new EmbedBuilder()
    .setTitle(drop.name)
    .setURL(drop.url)
    .setColor(drop.chain.includes('robinhood') ? 0x00c805 : 0x627eea)
    .setFooter({ text: `Source: ${drop.source} • ETH + Robinhood only` })
    .setTimestamp();

  if (drop.image) embed.setImage(drop.image);

  const supplyText =
    drop.maxSupply != null
      ? `${drop.totalSupply || 0} / ${drop.maxSupply}`
      : 'Check site';

  embed.addFields(
    { name: 'Supply', value: supplyText, inline: true },
    { name: 'Chain', value: drop.chain, inline: true }
  );

  (drop.stages || []).forEach(stage => {
    const price =
      stage.price != null
        ? `${(Number(stage.price) / 1e18).toFixed(4)} ETH`
        : 'Free / TBD';

    const start = stage.start_time
      ? new Date(stage.start_time).toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
          dateStyle: 'short',
          timeStyle: 'short'
        })
      : 'TBD';

    embed.addFields({
      name: `${stage.label || stage.stage_type || 'Mint'} · ${start} PST`,
      value: `Price: **${price}**`,
      inline: false
    });
  });

  return embed;
}

// ---------- Post ----------
async function postDrops(channel, isSlash = false) {
  const drops = await getTodaysMints();

  if (drops.length === 0) {
    const msg = 'No active ETH or Robinhood Chain mints found right now.';
    if (isSlash) return channel.editReply({ content: msg });
    return channel.send(msg);
  }

  if (!isSlash) {
    await channel.send(`**Today's NFT Mints** (${drops.length}) — ETH + Robinhood`);
  }

  for (const drop of drops) {
    const embed = buildEmbed(drop);
    if (isSlash) {
      await channel.followUp({ embeds: [embed] });
    } else {
      await channel.send({ embeds: [embed] });
    }
  }
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
