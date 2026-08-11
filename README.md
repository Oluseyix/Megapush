# About MegaPush

## Don't buy your lottery tickets. Win them.

Stake $10. The multiplier climbs: 1.00x, 1.84x, 2.71x. Bank at 3.4x and **34 real Megapot tickets** land in your wallet, entered in tonight's $1,000,000 drawing.

Let it run too long and the round crashes. The stake is gone.

## Why play here instead of just buying

**Ten dollars buys ten tickets anywhere.** On MegaPush, ten dollars can become forty.

**Every ticket is the real thing.** MegaPush doesn't run its own lottery. We buy genuine Megapot tickets and send them straight to your wallet. Same daily drawing, same prize pool, same odds as everyone else.

**97% RTP, and we earn more when you win.** Our house edge is 3%, matching the crash-game standard. But Megapot pays us a referral fee on every ticket you bank, which means we make roughly three times more from your wins than from your losses.

**Whole tickets, always.** No fractions. The number on the bank button is the number that lands in your wallet.

**Nobody holds your money but you.** Your balance sits in an escrow you can exit without our permission. Tickets go to your own wallet. Winnings are claimed by you, straight from the Megapot contract.

**You can check our maths.** Every round is cryptographically committed before betting opens and revealed after the crash. Verify it yourself in about thirty seconds. [Here's how](playing/provably-fair.md)

## Get started

* **New here?** [How it works](playing/how-to-play.md)
* **Ready to play?** [How to play](playing/how-to-play.md)
* **Want the numbers?** [Odds and payouts](learn/odds-and-payouts.md)

Currently on Base Sepolia testnet. Testnet tickets don't enter real drawings and carry no value. Don't send mainnet USDC to any MegaPush address.

MegaPush is a game of chance. Stake only what you can afford to lose. [Odds and payouts](learn/odds-and-payouts.md) · [Play responsibly](appendix/responsible-gaming.md)

## Repo notes (engineers)

- **Live app / Worker:** Cloudflare Workers + static assets (`wrangler.toml`, `cf-worker/`, `public/`)
- **Deploy:** `npx wrangler deploy` → https://megapush.xnoxseyi.workers.dev
- **Provably fair (detailed):** [`docs/playing/provably-fair.md`](docs/playing/provably-fair.md)
- **Cloudflare setup:** [`CLOUDFLARE.md`](CLOUDFLARE.md)
- Cashout settles instantly and mints tickets in the background; settled wins never refund stake
- Do not commit `.env`, `.dev.vars`, or private keys
