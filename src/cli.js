#!/usr/bin/env node
require('dotenv').config();
const { runPipeline, runAndPersist } = require('./pipeline');
const { postWebhook } = require('./delivery/webhook');
const { log } = require('./log');

async function main() {
  const args = process.argv.slice(2);
  const mock = args.includes('--mock') || process.env.ALPHA_MOCK === '1';
  const dry = args.includes('--dry') || args.includes('dry') || !args.includes('--post');
  const persist = args.includes('--persist');

  const result = persist
    ? await runAndPersist({ mock, dry: false, applyPostedDedupe: !args.includes('--all') })
    : await runPipeline({
        mock,
        applyPostedDedupe: !args.includes('--all'),
        persist: !dry
      });

  console.log('\n' + result.digest.text + '\n');
  log(`scanned=${result.scanned} listed=${result.items.length} mock=${mock}`);

  if (!dry) {
    await postWebhook(result.digest);
    if (result.items.length) {
      const { markPosted } = require('./store');
      markPosted(result.items);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
