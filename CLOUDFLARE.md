# Cloudflare Pages — MegaPush (Advanced Worker)

APIs are served by **`public/_worker.js`** (bundled from `cf-worker/`), not only static HTML.

## Dashboard settings

| Setting | Value |
|--------|--------|
| Root directory | **blank** (repo root) |
| **Build command** | `npm install && npm run build` |
| **Build output directory** | `public` |
| Compatibility flags | `nodejs_compat` |

## Secrets

**Settings → Variables and Secrets** (Production):

| Name | Type |
|------|------|
| `HOUSE_PRIVATE_KEY` | Encrypt / Secret |

Redeploy after adding.

## CLI deploy (from repo root)

```bash
cd MegaPush
npm install
npm run build          # creates public/_worker.js
npx wrangler pages deploy public --project-name megapush
```

## Verify (must be JSON)

```bash
curl -sS https://megapush.pages.dev/api/ping
# {"ok":true,"platform":"cloudflare-pages-worker",...}

curl -sS https://megapush.pages.dev/api/health
# {"ok":true,"hasHousePrivateKey":true,...}
```

If you still see `<!DOCTYPE html>`, the deploy did not include `_worker.js` — run `npm run build` and check `public/_worker.js` exists before deploy.
