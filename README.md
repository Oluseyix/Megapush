# MegaPush

Crash game that cash-outs into **Megapot lottery tickets** (not USDC).  
**Chain: Base Sepolia** (`84532`).

## Deliverable

| Path | What |
|------|------|
| `public/index.html` | **Landing** — Play CTA → game |
| `public/game.html` | **Main game** — single-file HTML/CSS/JS + viem CDN |
| `megapush.html` | Game file at project root (easy open / share) |
| `src/` | Optional Vite + React shell |

## Run

```bash
# Static (no install)
npx --yes serve public -p 5173
# open http://localhost:5173/game.html

# Or Vite shell
npm install && npm run dev
# http://localhost:5173        → shell
# http://localhost:5173/game.html → game
```

Wallet needs: **Base Sepolia**, funds to **stake from your wallet**, plus ETH for gas (claims). Cash-out does **not** charge the player USDC.

## Config (top of Megapot module in `game.html`)

```js
const REFERRER = '0x0000000000000000000000000000000000000001';
const HOUSE_BUY_URL = ''; // production: your house buy backend
```

- **`REFERRER`** — operator wallet (referral fees). Replace before prod.
- **`HOUSE_BUY_URL`** — `POST { count, recipient, referrer, source, chainId }`.  
  Backend holds house key + USDC and calls Megapot `buyTickets`.  
  **Empty = demo house** (UI ticket credit only).  
  **Never put a private key in the frontend.**

Source tag: `keccak256('megapush')`.

## Economy

1. Stake from the **player wallet** (connected on Base Sepolia)
2. Multiplier climbs
3. Cash out → tickets ≈ `floor(stake × multiplier)`
4. **House** buys those Megapot tickets for the player
5. Frontend **never** pulls player USDC again on cash-out
6. Draw wins claimed later via `claimWinnings` → USDC

## Base Sepolia contracts

| Contract | Address |
|----------|---------|
| Jackpot | `0x465dA3c859f193A3807386387bEE941B2A4c3279` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| RandomBuyer | `0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746` |
| Batch | `0x62A5D60F486D01a28071652a7951Aff1EA4c5b7c` |
| TicketNFT | `0x45084829ac63f9dC6a3D4981A46FA896f9180ECd` |

RPC: `https://sepolia.base.org`

## Product checklist

- Dual entries, auto cash-out (locked after bet), cancel queued (refund, same button color)
- Custom stake deselects pills unless exact match
- Slim “Tonight’s Megapot” (amount only)
- Mission FAB (side), not full-width bar
- Pages: Play · Tickets · Board · Winnings
- Past filters only under Past drawings
- Withdraw: single page (no wizard)
- `houseBuyTickets` on cash-out; `buyRandomTickets` tools-only

## Docs

- https://docs.megapot.io
- https://llms.megapot.io/tasks/buy-random
- https://llms.megapot.io/tasks/buy-bulk
- https://llms.megapot.io/tasks/claim-winnings
