# MegaPush

Crash-style game on **Base Sepolia**. Players deposit USDC to a play balance, stake into a global synchronized round, and cash out for **Megapot lottery tickets**.

## Play

Serve the static app (or open the deployed Worker origin):

```bash
npm install
npx wrangler dev
# open /game.html
```

## Deploy

```bash
npx wrangler deploy
```

Configure secrets in the Cloudflare dashboard (or CLI) — never commit private keys:

- House wallet private key (signs ticket purchases)
- Optional round fairness secret
- Optional admin token (ops only)

## Contracts (Base Sepolia)

Public Megapot / USDC addresses used by the client are in `public/game.html`. Escrow sources live under `contracts/`.

## Security notes

- Do not commit `.env`, `.dev.vars`, or private keys
- House signing keys stay server-side only
- Prefer a dedicated fairness secret separate from the house key
