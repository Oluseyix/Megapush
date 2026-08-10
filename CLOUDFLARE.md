# Cloudflare deploy

```bash
npm install
npx wrangler deploy
```

## Secrets

Set secrets in the Cloudflare dashboard (or CLI). Never commit them.

Required for cashouts: house wallet private key.  
Recommended: dedicated round fairness secret.  
Optional: admin token for rare ops-only Durable Object admin routes.

Local development: put values in `.dev.vars` (gitignored).

```bash
npx wrangler dev
```

Static files: `public/`. Worker entry: `cf-worker/index.js`.
