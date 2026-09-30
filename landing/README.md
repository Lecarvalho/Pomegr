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

The dev server opens at `http://127.0.0.1:8788/`. Vite disables remote bindings,
so local startup does not require Cloudflare login. See [local startup and troubleshooting](../docs/internal/operations/website.md#run-the-landing-locally).

## Desktop downloads

`/download` offers the Windows x64 installer and portable executable, linking directly
to official GitHub release assets. The server reads the latest stable release metadata
with a three-second timeout and a 15-minute Cloudflare fetch cache. Both expected assets
must validate together; URLs are constructed only for this repository. If GitHub is
unavailable or returns incomplete metadata, the page uses the verified v0.3.3 release
in `server/download-release.ts`, including its actual version and file sizes. Update
that fallback when retiring an older release. No GitHub token or browser API call is needed.

Page visits can be measured by separately configured Web Analytics. This page adds
no click tracking and does not claim to measure completed downloads or unique users.

## Documentation content

The `/docs` pages, their search index, the sitemap, and `robots.txt` are built from the repository's public documentation: `docs/site.json` and the pages and images it selects under `docs/public/`. `npm run docs:prepare` validates that selection and writes the gitignored `generated/` and `public/docs/` outputs. `dev`, `test`, `typecheck`, and `build` run it first, so invalid documentation stops them and no artifact is built from it. `scripts/docs-content.mjs` is the only code in this package that reads outside it, and it reads only those two inputs; `build:audit` checks that boundary and the generated output. From the repository root, `npm run check:docs` applies the same rules plus the repository-wide documentation checks. Publishing documentation is a website deployment, independent of desktop packaging: see [publish documentation](../docs/internal/operations/website.md#6-publish-documentation).

## Audited deployment

```powershell
cd landing
npm ci
npm test
npm run typecheck
npm run build:audit
npm run deploy
```

Run `npm run check:docs` from the repository root first when documentation changed; the [Deploy landing workflow](../.github/workflows/deploy-landing.yml) does. `build:audit` rejects imports outside this package, source maps, local-only routes, and recognizable Dashboard, monitor, desktop, web, or shared-local modules. `deploy` first refuses placeholder production bindings, then audits again and gives Wrangler `dist/server/wrangler.json`, whose entry and static asset directory both point inside the already-built `landing/dist` artifact. It does not rebuild the root Pomegr application.

Provisioning, DNS, WAF, secrets, smoke tests, and rollback are documented in [website operations](../docs/internal/operations/website.md).
