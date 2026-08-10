# Cloudflare Pages — MegaPush

## Why `/api/health` showed the landing page

That HTML is `index.html`. It means **Functions did not run** — only static files were deployed.

Usual causes:

1. **Root directory = `public`** → `functions/` is ignored  
2. **Deployed only the `public` folder** (drag-drop / wrong path) without `functions/`  
3. **No redeploy** after adding secrets / code  

## Correct dashboard settings

**Workers & Pages → megapush → Settings → Builds and deployments:**

| Field | Value |
|--------|--------|
| Production branch | `main` |
| **Root directory** | *(leave blank)* = **repo root** |
| **Build command** | `npm install` |
| **Build output directory** | `public` |

**Settings → Functions:**

- Compatibility flags: **`nodejs_compat`**

**Settings → Environment variables** (Production):

| Name | Type |
|------|------|
| `HOUSE_PRIVATE_KEY` | **Encrypt / Secret** |

Then **Deployments → ⋯ → Retry deployment**.

## Correct CLI deploy (from repo root)

```bash
cd MegaPush   # must contain both public/ AND functions/
npm install
npx wrangler pages deploy public --project-name megapush
```

Do **not** `cd public` before deploy.

## Verify (must be JSON, not HTML)

```bash
curl -sS https://megapush.pages.dev/api/ping
# {"ok":true,"platform":"cloudflare-pages","route":"/api/ping",...}

curl -sS https://megapush.pages.dev/api/health
# {"ok":true,"hasHousePrivateKey":true,"platform":"cloudflare-pages",...}
```

If `curl` still returns `<!DOCTYPE html>`, Functions are still not deployed — fix Root directory and redeploy.

## Game URL

https://megapush.pages.dev/game.html
