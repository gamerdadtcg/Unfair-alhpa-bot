# Live sources

Never invent APIs. If a request 404s, the bot logs `SOURCE 404 (skipped):` and moves on.

## Used

- OpenSea `GET /api/v2/drops?type=&chains=&limit=`
- OpenSea `GET /api/v2/drops/{slug}`
- OpenSea `GET /api/v2/collections/{slug}`
- OpenSea `GET /api/v2/collections?chain=&order_by=created_date` (skipped if 404)
- Alchemy `alchemy_getAssetTransfers` when `ETH_RPC` is an Alchemy URL (ERC-721 + ERC-1155)
- Generic `eth_getLogs` Transfer / TransferSingle / TransferBatch from 0x0
- Same mint-log path on `RH_RPC` for Robinhood Chain
- Blockscout v2 `GET /smart-contracts/{address}`
- Blockscout v2 `GET /addresses/{address}` (creator)
- Blockscout v2 `GET /tokens/{address}`
- Blockscout v2 `GET /tokens/{address}/holders` (top-wallet %)
- Blockscout v2 `GET /tokens?type=ERC-721|ERC-1155`
- `eth_call` ERC-2981 `royaltyInfo` (plus, never required)
- Official RH explorer `https://robinhoodchain.blockscout.com/api/v2`
- Fallback RH `https://api.blockscout.com/4663/api/v2`

## Not used

- Unofficial robinscan clones
- NFT Calendar as a sole source
- Memecoin / bonding-curve token APIs
