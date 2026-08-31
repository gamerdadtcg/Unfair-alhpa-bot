require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events
} = require('discord.js');
const cron = require('node-cron');
const { MORNING_CRON, DISCORD_TOKEN, CLIENT_ID, CHANNEL_ID, DISCORD_WEBHOOK } = require('./config');
const { log, logError } = require('./log');
const { runPipeline } = require('./pipeline');
const { markPosted } = require('./store');
const { postWebhook } = require('./delivery/webhook');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function digestPayload(digest) {
  const description =
    digest.content.length > 4000 ? digest.content.slice(0, 3990) + '\n…' : digest.content;
  return {
    content: null,
    embeds: [{ title: 'GM ALPHA', description, color: 0x111111 }]
  };
}

async function deliverDigest(digest, { interaction } = {}) {
  if (interaction) {
    await interaction.editReply(digestPayload(digest));
    return;
  }
  if (DISCORD_WEBHOOK) {
    await postWebhook(digest);
    return;
  }
  if (CHANNEL_ID && client.isReady()) {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send(digestPayload(digest));
  } else {
    log('No webhook or CHANNEL_ID; printing digest only');
    console.log(digest.text);
  }
}

async function runMorning({
  interaction = null,
  applyPostedDedupe = true,
  markAsPosted = true
} = {}) {
  const result = await runPipeline({ applyPostedDedupe });
  await deliverDigest(result.digest, { interaction });
  if (markAsPosted && result.items.length) markPosted(result.items);
  return result;
}

const commands = [
  new SlashCommandBuilder()
    .setName('drops')
    .setDescription("Today's ETH + Robinhood mint alpha (one digest)")
    .setDefaultMemberPermissions(null)
    .toJSON()
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  log('Slash commands registered');
}

async function onReady() {
  log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    logError('Failed to register slash commands', err);
  }
}

client.once(Events.ClientReady ?? 'clientReady', onReady);

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'drops') return;
  try {
    await interaction.deferReply({ ephemeral: false });
    await runMorning({ interaction, applyPostedDedupe: false, markAsPosted: false });
  } catch (err) {
    logError('/drops failed', err);
    try {
      const msg = 'Alpha scan failed. Try again in a minute.';
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg });
      else await interaction.reply({ content: msg, ephemeral: true });
    } catch (_) {
      /* ignore */
    }
  }
});

cron.schedule(
  MORNING_CRON,
  async () => {
    log('Running 7:00 AM PT GM ALPHA digest...');
    try {
      await runMorning({ applyPostedDedupe: true });
    } catch (err) {
      logError('Morning digest failed', err);
    }
  },
  { timezone: 'America/Los_Angeles' }
);

process.on('unhandledRejection', err => logError('Unhandled rejection', err));
process.on('uncaughtException', err => logError('Uncaught exception', err));

if (DISCORD_TOKEN) {
  client.login(DISCORD_TOKEN);
} else {
  log('No DISCORD_TOKEN — bot idle. Use npm run scan:dry or npm run digest');
}

module.exports = { runMorning, client };
