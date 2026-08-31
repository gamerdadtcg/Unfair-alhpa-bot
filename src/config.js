try {
  require('dotenv').config();
} catch {
  /* optional in tests if dotenv is not installed yet */
}

const TZ = process.env.TZ || 'America/Los_Angeles';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const CHAINS = {
  ethereum: {
    id: 1,
    slug: 'ethereum',
    label: 'ETH',
    explorer: 'https://etherscan.io',
    blockscout: 'https://eth.blockscout.com/api/v2',
    rpc: process.env.ETH_RPC || ''
  },
  robinhood: {
    id: 4663,
    slug: 'robinhood',
    label: 'RH',
    explorer: 'https://robinhoodchain.blockscout.com',
    blockscout: 'https://robinhoodchain.blockscout.com/api/v2',
    blockscoutAlt: 'https://api.blockscout.com/4663/api/v2',
    rpc: process.env.RH_RPC || ''
  }
};

module.exports = {
  TZ,
  ZERO_ADDRESS,
  CHAINS,
  OPENSEA_API_KEY: process.env.OPENSEA_API_KEY || '',
  BLOCKSCOUT_KEY: process.env.BLOCKSCOUT_KEY || '',
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || '',
  CLIENT_ID: process.env.CLIENT_ID || '',
  CHANNEL_ID: process.env.CHANNEL_ID || '',
  GUILD_ID: process.env.GUILD_ID || '',
  SCORE_THRESHOLD: 60,
  SCORE_FALLBACK: 50,
  LIST_CAP: 8,
  MIN_PASS_BEFORE_FALLBACK: 3,
  BREAKING_THRESHOLD: 80,
  LOOKBACK_HOURS: 36,
  FIRST_MINT_HOURS: 24,
  STAGE_WINDOW_HOURS: 24,
  DEDUPE_DAYS: 7,
  REPOST_AFTER_HOURS: 18,
  SCORE_JUMP: 15,
  MORNING_CRON: '0 7 * * *'
};
