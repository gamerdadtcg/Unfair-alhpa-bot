const { postJson } = require('../http');
const { DISCORD_WEBHOOK } = require('../config');
const { log } = require('../log');

async function postWebhook(digest) {
  if (!DISCORD_WEBHOOK) {
    log('No DISCORD_WEBHOOK set; not posting webhook');
    return false;
  }
  const content = digest.content.length > 4000 ? digest.content.slice(0, 3990) + '\n…' : digest.content;
  const body = {
    content: null,
    embeds: [
      {
        title: 'GM ALPHA',
        description: content,
        color: 0x111111
      }
    ]
  };
  const res = await postJson(DISCORD_WEBHOOK, body);
  if (res == null) return false;
  log('Posted morning digest to Discord webhook');
  return true;
}

module.exports = { postWebhook };
