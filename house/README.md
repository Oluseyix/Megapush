# MegaPush house backend

Pays Megapot tickets on Base Sepolia when players cash out. Holds `HOUSE_PRIVATE_KEY` — **never** put that key in the frontend.

## Setup

```bash
cd house
cp .env.example .env
# edit HOUSE_PRIVATE_KEY + HOUSE_ADDRESS
# fund that address with Sepolia ETH + USDC
npm install
npm start
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/game/cashout` | Buy tickets for player (`count`, `recipient`, `entryId`) |
| POST | `/game/refund` | Refund stake USDC on cancel |
| POST | `/game/stake` | Optional stake bookkeeping |
| GET | `/health` | Liveness |

## Frontend config (`public/game.html`)

```js
const HOUSE_TREASURY = '0xYourHouseAddress';      // same as HOUSE_ADDRESS
const HOUSE_BUY_URL = 'http://localhost:8787/game/cashout';
```

Production: deploy this API over HTTPS and set `HOUSE_BUY_URL` accordingly.
