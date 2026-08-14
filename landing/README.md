# Pomegr public landing

This directory is the only deployable public application in the repository. It has its own dependency lock, build, Cloudflare Worker, D1 migration, tests, and deployment audit. It must not import from the local Pomegr application outside `landing/`.

## Local development

```powershell
cd landing
npm ci
Copy-Item .env.example .dev.vars
npm run db:migrate:local
npm run dev
```

Use Cloudflare's published Turnstile test keys in `.dev.vars`. `WAITLIST_ALLOW_LOCAL_DEV=true` is a local-only exception and must never be added to `wrangler.jsonc` or production secrets.

## Audited deployment

```powershell
cd landing
npm ci
npm test
npm run typecheck
npm run build:audit
npm run deploy
```

`build:audit` rejects imports outside this package, source maps, local-only routes, and recognizable Dashboard, monitor, desktop, web, or shared-local modules. `deploy` first refuses placeholder production bindings, then audits again and gives Wrangler `dist/server/wrangler.json`, whose entry and static asset directory both point inside the already-built `landing/dist` artifact. It does not rebuild the root Pomegr application.

Provisioning, DNS, WAF, secrets, smoke tests, and rollback are documented in [OPERATIONS.md](./OPERATIONS.md).
