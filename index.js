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
  // also treat as sold out if no active stages left
  const hasActiveStage = (drop.stages || []).some(s => {
    const now = Date.now();
    const start = s.start_time ? new Date(s.start_time).getTime() : 0;
    const end = s.end_time ? new Date(s.end_time).getTime() : Infinity;
    return now >= start && now <= end;
  });
  return !hasActiveStage && total > 0;
}

// ---------- OpenSea ----------
async function fetchOpenSeaDrops() {
  try {
    const res = await axios.get('https://api.opensea.io/api/v2/drops', {
      params: {
        type: 'upcoming',
        chains: 'ethereum,robinhood',
        limit: 50
      },
      headers: OPENSEA_HEADERS
    });

    const drops = res.data.drops || [];
    const results = [];

    for (const drop of drops) {
      try {
        const detail = await axios.get(
          `https://api.opensea.io/api/v2/drops/${drop.collection_slug}`,
          { headers: OPENSEA_HEADERS }
        );
        const d = detail.data;

        // only keep stages that start today
        const todayStages = (d.stages || []).filter(s => isToday(s.start_time));
        if (todayStages.length === 0) continue;

        if (isSoldOut(d)) continue;

        results.push({
          name: d.collection_name || drop.collection_name,
          chain: (d.chain || drop.chain || '').toLowerCase(),
          slug: d.collection_slug,
          url: d.opensea_url || `https://opensea.io/collection/${d.collection_slug}`,
          image: d.image_url || null,
          maxSupply: d.max_supply,
          totalSupply: d.total_supply,
          stages: todayStages,
          source: 'opensea'
        });
      } catch (e) {
        // skip individual failures
      }
    }
    return results;
  } catch (err) {
    console.error('OpenSea error:', err.message);
    return [];
  }
}

// ---------- nftcalendar.io fallback (lightweight) ----------
async function fetchNftCalendarFallback(existingSlugs = new Set()) {
  try {
    const { data } = await axios.get('https://nftcalendar.io/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(data);
    const results = [];

    // Very simple parse – looks for today's section
    $('h2, h3').each((_, el) => {
      const title = $(el).text().trim();
      if (!title || title.length < 3) return;

      const next = $(el).nextAll().slice(0, 6);
      let text = next.text().toLowerCase();
      let link = next.find('a').attr('href') || '';

      // only ETH + Robinhood mentions
      const isEth = text.includes('ethereum') || text.includes(' eth ');
      const isRobinhood = text.includes('robinhood');
      if (!isEth && !isRobinhood) return;

      // rough "today" check
      if (!text.includes('aug 14') && !text.includes('august 14') && !text.includes('today')) return;

      const slugGuess = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (existingSlugs.has(slugGuess)) return;

      results.push({
        name: title,
        chain: isRobinhood ? 'robinhood' : 'ethereum',
        slug: slugGuess,
        url: link.startsWith('http') ? link : `https://nftcalendar.io${link}`,
        image: null,
        maxSupply: null,
        totalSupply: null,
        stages: [{ label: 'Public / Check site', start_time: new Date().toISOString(), price: null }],
        source: 'nftcalendar'
      });
    });

    return results.slice(0, 8); // keep it small
  } catch (err) {
    console.error('nftcalendar scrape error:', err.message);
    return [];
  }
}

// ---------- Main fetch ----------
async function getTodaysMints() {
  const openSea = await fetchOpenSeaDrops();
  const existing = new Set(openSea.map(d => d.slug));
  const fallback = await fetchNftCalendarFallback(existing);

  // prefer OpenSea data
  return [...openSea, ...fallback];
}

// ---------- Embed builder ----------
function buildEmbed(drop) {
  const embed = new EmbedBuilder()
    .setTitle(`${drop.name}`)
    .setURL(drop.url)
    .setColor(drop.chain.includes('robinhood') ? 0x00c805 : 0x627eea)
    .setFooter({ text: `Source: ${drop.source} • ETH + Robinhood only` })
    .setTimestamp();

  if (drop.image) embed.setImage(drop.image);

  const supplyText =
    drop.maxSupply != null
      ? `${drop.totalSupply || 0} / ${drop.maxSupply}`
      : 'Check site';
  embed.addFields({ name: 'Supply', value: supplyText, inline: true });
  embed.addFields({ name: 'Chain', value: drop.chain, inline: true });

  drop.stages.forEach(stage => {
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

// ---------- Post logic ----------
async function postDrops(channel, isSlash = false) {
  const drops = await getTodaysMints();

  if (drops.length === 0) {
    const msg = 'No active ETH or Robinhood Chain mints scheduled for today.';
    if (isSlash) return channel.reply({ content: msg, ephemeral: true });
    return channel.send(msg);
  }

  // header
  if (!isSlash) {
    await channel.send(`**Today's NFT Mints** (${drops.length}) — ETH + Robinhood only`);
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

// ---------- Slash command ----------
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

// ---------- Daily cron: 12:00 AM PST ----------
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
