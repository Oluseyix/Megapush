# Cloudflare Workers deploy

Primary (and only) deploy path: **Workers + Static Assets**.

```bash
npm install
npx wrangler deploy
```

## Secrets

Set in the Cloudflare dashboard or CLI. Never commit them.

| Secret | Required? |
|--------|-----------|
| `ROUND_SECRET` | **Yes** — ≥16 chars. Without it the Worker keeps betting closed. |
| `HOUSE_PRIVATE_KEY` | **Yes for cashouts** — house wallet signing key. |
| `ADMIN_TOKEN` | **Yes if you need admin DO routes.** If unset, admin routes **404**. |

```bash
npx wrangler secret put ROUND_SECRET
npx wrangler secret put HOUSE_PRIVATE_KEY
npx wrangler secret put ADMIN_TOKEN   # only when enabling admin routes
```

Local: `.dev.vars` (gitignored).

```bash
npx wrangler dev
```

- Static UI: `public/`  
- Worker entry: `cf-worker/index.js`  
- Durable Objects: `ROUND_DO`, `TX_SEQUENCER_DO` in `wrangler.toml`  
