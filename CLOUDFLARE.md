# Deploy MegaPush on Cloudflare Pages

Works around Vercel deploy rate limits. Same app: static files in `public/` + API under `/api/*`.

## 1. Create the project

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages**
2. **Create** → **Pages** → **Connect to Git**
3. Select **Oluseyix/Megapush** (or your fork)
4. Build settings:

| Setting | Value |
|--------|--------|
| Framework preset | **None** |
| Build command | *(leave empty)* or `echo ok` |
| Build output directory | `public` |
| Root directory | `/` (repo root) |

5. **Save and Deploy**

## 2. Secrets (required for cash-out / refund)

**Settings → Environment variables** (Production + Preview):

| Name | Required | Notes |
|------|----------|--------|
| `HOUSE_PRIVATE_KEY` | **Yes** | Same key as Vercel — wallet `0x804BEb…` |
| `ROUND_SECRET` | Optional | Global mult seed |
| `RPC_URL` | Optional | Default `https://sepolia.base.org` |

Then **Retry deployment** (env vars apply after redeploy).

## 3. Verify

```text
https://YOUR-PROJECT.pages.dev/api/health
```

Expect:

```json
{ "ok": true, "hasHousePrivateKey": true, "treasuryMatch": true }
```

Game:

```text
https://YOUR-PROJECT.pages.dev/game.html
```

Cash-out still calls `/api/cashout` (relative) — works on Pages the same as Vercel.

## 4. Custom domain (optional)

Pages → **Custom domains** → add `play.yourdomain.com` (or move off Vercel when ready).

## 5. CLI deploy (optional)

```bash
npm i -g wrangler
wrangler login
# set secret
echo "YOUR_KEY" | wrangler pages secret put HOUSE_PRIVATE_KEY --project-name megapush
wrangler pages deploy public --project-name megapush
```

Functions in `functions/api/*` are picked up automatically on Git deploys.

## How it works

- **Static:** `public/` (landing + `game.html`)
- **API:** `functions/api/{cashout,refund,health,round}.js` → wraps existing `api/*.js` (Vercel handlers)
- **Compatibility:** `nodejs_compat` so `viem` + house txs run on Workers
