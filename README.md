# MegaPush

Crash-style game on **Base Sepolia**. Players deposit USDC to a play balance, stake into a global synchronized round, and cash out for **Megapot lottery tickets**.

## Play (local)

```bash
npm install
# Required secrets in .dev.vars (gitignored):
#   ROUND_SECRET=…          (≥16 chars — fairness seed material; no fallback)
#   HOUSE_PRIVATE_KEY=…     (signs ticket purchases)
#   ADMIN_TOKEN=…           (only if you use DO admin routes; routes 404 when unset)
npx wrangler dev
# open /game.html
```

## Deploy

```bash
npx wrangler deploy
```

Set secrets in the Cloudflare dashboard or via `wrangler secret put`. **Never commit private keys.**

| Secret | Role |
|--------|------|
| `ROUND_SECRET` | **Required.** Provably-fair seed material. Worker **refuses to open a betting window** without it (≥16 characters). Not derived from the house key. |
| `HOUSE_PRIVATE_KEY` | **Required for cashouts.** Signs Megapot ticket buys and house USDC outflows. |
| `ADMIN_TOKEN` | **Required to enable admin DO routes** (`/kill`, `/reset-exposure`, `/close-window`, sequencer `/clear`). If unset, those routes **404** (they do not exist). If set, wrong bearer → 403. |

## Free daily ticket

Once every **24 hours**, a connected wallet can claim **1 free Megapot ticket** (house-funded, delivered to the player wallet). No stake required. Reset is a rolling 24h from last claim.

- UI: **Free daily** in the header  
- API: `POST /api/bank` with `{ "action": "free_daily", "player": "0x…" }`  
- First-visit FAQ explains this on the second onboard step  

## Money model

| Pool | Meaning |
|------|---------|
| **Deposited** | USDC deposited and never consumed by a settled round — **withdrawable** |
| **Progress** | Fractional ticket dollars from cashouts (`stake × mult` remainder) — **tickets only**, never withdrawable |
| **Staked / cashed** | Leaves as **whole tickets** to the player wallet (`floor(stake × mult)`) |

Example: **$10 @ 3.47× → 34 tickets + $0.70 progress**. When progress reaches $1.00, one free ticket is bought to the player wallet.

## How to withdraw (escrow)

When using `MegaPushEscrow` (`contracts/src/MegaPushEscrow.sol`):

1. **`requestWithdraw()`** — player starts a withdrawal. Deposits are blocked while pending.  
2. **Challenge window** — `WITHDRAW_DELAY` (**5 minutes**). House can settle outstanding signed hands before funds leave.  
3. **`withdraw()`** — after `unlockTime`, player pulls the full remaining balance to their wallet (no house cooperation required).

Cancel a pending request with `cancelWithdraw()` if you need to deposit again sooner; otherwise wait the 5 minutes (or settle open hands), then withdraw.

Off-chain play-bank withdraw (current Worker bank) sends house USDC to the player after debiting the KV balance — still requires the house key on the Worker.

## How to verify a round (commit–reveal)

After a hand crashes, the server reveals `serverSeed`. During betting/flying only `serverSeedHash` (the commit) was public.

### Recipe

1. Wait until `/api/round` (or round history) includes:
   - `serverSeedHash` (commit published earlier)
   - `serverSeed` (reveal)
   - `crashMult` (crash point shown on the TV)
2. Check the commit:

```text
sha256(serverSeed)  ===  serverSeedHash
```

3. Recompute the crash point (Bustabit-style, first 52 bits of the hash as hex):

```text
n = int(serverSeed[0:13], 16)   // 52 bits
if n % 33 == 0:
  crash = 1.00
else:
  crash = floor( (100 * 2^52 - n) / (2^52 - n) ) / 100
  crash = min(10000, max(1, round(crash, 2)))
```

4. Confirm `crash` matches the published `crashMult` (allow tiny float rounding, e.g. 0.015).

### HTTP helper

```bash
curl -sS -X POST "$ORIGIN/api/verify" \
  -H 'Content-Type: application/json' \
  -d '{"serverSeed":"…","serverSeedHash":"…","crashMult":2.58}'
```

Expect `ok: true`, `commitOk: true`, `crashOk: true`.

Optional: pass `flyStart` + `cashoutAt` (+ `expectedSettlementMult`) to check that a cashout mult sits on the **same** exponential curve at server arrival time.

The game UI also runs this check client-side after reveal (`verifyFairRound` + `POST /api/verify`).

## Contracts

Escrow sources: `contracts/src/`. Public Megapot / USDC addresses used by the client are in `public/game.html`.

## Security notes

- Do not commit `.env`, `.dev.vars`, or private keys  
- House signing key ≠ fairness secret  
- No local Express house server — production path is the Worker only  
