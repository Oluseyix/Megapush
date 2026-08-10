# MegaPush

Crash game on **Base Sepolia**. Stakes are **real Sepolia USDC** from the player wallet. Cash-out pays **Megapot tickets** bought by a **house backend** (player is not charged again on cash-out).

## Option A (current)

| Action             | Who pays / signs                                  |
| ------------------ | ------------------------------------------------- |
| Connect            | Player wallet → Base Sepolia                      |
| Stake / buy entry  | Player signs **USDC transfer** → `HOUSE_TREASURY` |
| Cancel queued      | House backend **refunds** USDC to player          |
| Cash out           | House backend buys Megapot tickets for player     |
| Claim lottery wins | Player signs `claimWinnings`                      |

**No paper balance. No fake tickets.**

## Run frontend

```bash
cd MegaPush
npx --yes serve public -p 5173
# http://localhost:5173/           landing
# http://localhost:5173/game.html  game
```

## Config (`public/game.html` Megapot module)

```js
const HOUSE_TREASURY = '0xYourHouseWallet';           // receives stakes
const HOUSE_BUY_URL = '/api/cashout';  // Vercel serverless
const REFERRER = '0x804BEb025844c189b72C8D810a1A7776043677FF';
const REFERRER = '0x0000000000000000000000000000000000000001';
const RPC = 'https://sepolia.base.org';
```

## House backend

```bash
cd house
cp .env.example .env   # HOUSE_PRIVATE_KEY + HOUSE_ADDRESS
npm install && npm start
```

Fund house with **Sepolia ETH + USDC**. See `house/README.md`.

## Contracts (Base Sepolia)

| Contract    | Address                                      |
| ----------- | -------------------------------------------- |
| Jackpot     | `0x465dA3c859f193A3807386387bEE941B2A4c3279` |
| USDC        | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| RandomBuyer | `0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746` |
| Batch       | `0x62A5D60F486D01a28071652a7951Aff1EA4c5b7c` |
| TicketNFT   | `0x45084829ac63f9dC6a3D4981A46FA896f9180ECd` |

Source tag: `keccak256('megapush')`.

## Vercel

Set env **HOUSE\_PRIVATE\_KEY** in the Vercel project (never commit it).

Serverless route: `POST /api/cashout` — house buys tickets for the player.

```js
const HOUSE_TREASURY = '0x804BEb025844c189b72C8D810a1A7776043677FF';
const HOUSE_BUY_URL = '/api/cashout';
const REFERRER = '0x804BEb025844c189b72C8D810a1A7776043677FF';
```
