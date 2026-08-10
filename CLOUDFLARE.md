# Deploy MegaPush on Cloudflare Pages

## Critical settings (this was the /api/health → landing bug)

| Setting | Value |
|--------|--------|
| **Root directory** | **empty / repository root** (NOT `public`) |
| **Build command** | empty or `echo ok` |
| **Build output directory** | `public` |
| **Compatibility flags** | `nodejs_compat` (Settings → Functions) |

If Root directory is set to `public`, Functions never deploy and `/api/*` falls through to the landing HTML.

## Connect Git

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select **Oluseyix/Megapush**
3. Use the settings table above
4. Deploy

## Secrets

**Settings → Environment variables** (Production + Preview):

| Name | Type | Required |
|------|------|----------|
| `HOUSE_PRIVATE_KEY` | **Secret** | Yes |
| `ROUND_SECRET` | Secret | Optional |
| `RPC_URL` | Text | Optional |

Then **Retry deployment**.

## Verify

```bash
curl -sS https://megapush.pages.dev/api/health
```

Must return JSON, e.g.:

```json
{ "ok": true, "platform": "cloudflare-pages", "hasHousePrivateKey": true }
```

If you still get the **landing HTML** page:

1. Root directory is wrong (must be repo root)
2. Redeploy after fixing
3. Confirm Functions show under the deployment (not “0 functions”)

Game: `https://megapush.pages.dev/game.html`
