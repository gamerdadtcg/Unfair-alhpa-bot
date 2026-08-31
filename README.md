# Unfair Alpha Bot

Daily mint-alpha for **Ethereum** and **Robinhood Chain (4663)**. One morning digest. No drip. No farm spam.

## File tree

```
index.js                      Discord process entry (Railway start)
src/
  bot.js                      slash /drops + 7:00 AM PT cron
  cli.js                      scan:dry / digest
  pipeline.js                 collect → enrich → filter → score → cap
  filters.js                  hard rejects
  scorer.js                   0–100 score (on-chain / social / team / timing)
  store.js                    7-day dedupe memory (data/store.json)
  digest.js                   GM ALPHA message format
  enrich.js                   Blockscout verified + holders
  collectors/
    opensea.js                drops + new collections (ETH + RH)
    mintLogs.js               ERC-721/1155 Transfer-from-zero (Alchemy or logs)
    ethMints.js               ETH on-chain first mints
    rhMints.js                RH Blockscout NFTs + RH_RPC mint logs
  delivery/webhook.js         Discord webhook adapter
  fixtures/                   mocked good / farm / repeat mints
data/blacklist.json           deployer + slug blacklist
tests/                        node:test fixtures
```

Calendar scrapes are **not** in the live pipeline (they lag and include junk). OpenSea + on-chain + Blockscout only.

## Env

```
TZ=America/Los_Angeles
OPENSEA_API_KEY=
ETH_RPC=                      # Alchemy URL unlocks getAssetTransfers; any EVM RPC can use logs
RH_RPC=
BLOCKSCOUT_KEY=               # optional
ETHERSCAN_API_KEY=            # optional, unused if Blockscout answers
DISCORD_WEBHOOK=              # preferred morning delivery
DISCORD_TOKEN=                # discord.js bot for /drops
CLIENT_ID=
CHANNEL_ID=                   # fallback if no webhook
GUILD_ID=
```

Missing keys are skipped, not fatal.

## Run

```bash
npm install

# Mocked digest — judge the voice, no keys required
npm run scan:dry

# Live scan, print only (needs OPENSEA_API_KEY and/or RPCs)
npm run digest

# Live scan and POST to DISCORD_WEBHOOK
npm run digest:post

# Discord bot: /drops + 7:00 AM PT digest
npm start

npm test
```

Morning job: `0 7 * * *` America/Los_Angeles. One message. Max 8 mints, score ≥ 60 (falls back to 50 once if fewer than 3 pass). Never pads with junk.

`/drops` runs the same pipeline and posts the same single digest. It does **not** drip individual cards, and it does **not** mark collections as posted (so a 6am `/drops` cannot empty the 7am GM ALPHA).

## Quality bar

Rejected immediately: no contract, not minting in 24h, bot-farm holder/minter ratios, deployer/top-wallet concentration, generic ape/punk names, OrangeHare, unverified + no OpenSea + tiny mint, already posted in 7 days (unless a new stage or +15 score jump).

## Sources

See `SOURCES.md` if an endpoint 404s at runtime (`SOURCE 404 (skipped): …` in logs).
