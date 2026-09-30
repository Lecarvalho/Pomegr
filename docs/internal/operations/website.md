# Website operations

> Scope: local development, provisioning, manual deployment, documentation publication, smoke checks, and rollback of the public landing Worker in `landing/`.
> Authority: operating procedure. [`landing/README.md`](../../../landing/README.md) stays the package entrypoint and links here.
> Related code and checks: `landing/package.json` scripts (`test`, `typecheck`, `build:audit`, `deploy`), `landing/scripts/`, `npm run check:docs`, and the [Deploy landing workflow](../../../.github/workflows/deploy-landing.yml).

This guide covers local development and publishing the public landing Worker. Provisioning commands in sections 1-4 run from `landing/`. Local startup and the release commands in section 5 run from the repository root and explicitly select the landing package with `--prefix landing`.

## Run the landing locally

Use Node.js 22.13 or newer. From the repository root, install the landing's separate dependencies once (and again when its lockfile changes):

```powershell
Set-Location C:\Workspace\repos\Pomegr
npm --prefix landing ci
```

Start the development server in PowerShell:

```powershell
npm --prefix landing run dev
```

Open [the landing page](http://127.0.0.1:8788/), [About](http://127.0.0.1:8788/about), [Downloads](http://127.0.0.1:8788/download), or [Docs](http://127.0.0.1:8788/docs). The server reloads source changes automatically. Leave the terminal running; press **Ctrl+C** to stop. If already inside `landing/`, use `npm run dev`.

`landing/vite.config.ts` sets `remoteBindings: false`, so the Cloudflare Vite plugin simulates bindings locally, including the `pomegr_waitlist` binding marked `remote: true` in `landing/wrangler.jsonc`. No shell environment variable, Cloudflare login, or API token is needed to preview these pages. This development option does not change production bindings. The site is not fully offline: release metadata comes from GitHub, and the waitlist widget uses Turnstile. Downloads still target real GitHub release files.

The landing is independent of the desktop/dashboard development server on port 3003. Running `npm run dev` at the repository root starts that application instead of the landing.

Before `dev`, `test`, `typecheck`, and `build`, npm runs `docs:prepare`. It validates `docs/site.json` and the public pages and images that manifest selects, then writes the gitignored `landing/generated/` (the content and its search index) and `landing/public/docs/` outputs the site bundles; invalid documentation stops the command with every problem listed, so `build` and `build:audit` cannot produce an artifact from it. Restart the dev server after editing documentation. The [documentation manifest](../development/documentation-manifest.md#generate-the-website-content) defines the loader, its outputs, and the content-input audit that `build:audit` enforces.

### Local waitlist configuration

Page previews do not require waitlist secrets. To configure the local widget and database, first copy the example only if a local configuration does not already exist:

```powershell
if (-not (Test-Path -LiteralPath landing/.dev.vars)) {
  Copy-Item -LiteralPath landing/.env.example -Destination landing/.dev.vars
}
npm --prefix landing run db:migrate:local
```

Edit `landing/.dev.vars`, keeping `ENVIRONMENT=development`, `WAITLIST_ALLOW_LOCAL_DEV=true`, and the supplied `127.0.0.1:8788` origin and host. Set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` using [Cloudflare's published test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/), and replace `WAITLIST_COOKIE_SECRET` with a locally generated secret containing at least 32 random bytes. Restart the dev server after changing this file. Never commit `.dev.vars` or put its development settings into production configuration.

Current limitation: the backend checks Turnstile's hostname against `pomegr.com` and its action against `waitlist_signup`, even in development. Dummy keys can exercise the local widget but do not provide a complete successful signup flow through that validation. Use `npm --prefix landing test` for the signup handler's automated success/failure cases; a production signup smoke test is a separate step. Do not use `db:migrate:remote` for local setup.

### Startup troubleshooting

- **Cloudflare sign-in tab / remote proxy session / missing `CLOUDFLARE_API_TOKEN`:** cancel the login and stop the old process with Ctrl+C. Confirm `remoteBindings: false` is present in `landing/vite.config.ts`, then restart with `npm --prefix landing run dev`. The local preview does not need authorization. Do not use `wrangler login`, `deploy`, or `release` to start it.
- **Port 8788 is occupied:** stop the existing landing server with Ctrl+C before starting another copy. Keep the documented port so local waitlist origin checks agree.
- **Missing dependencies or CLI:** run `npm --prefix landing ci`; installing only the root package is insufficient.
- **Old compiled preview:** use the development command above for source edits. A Wrangler preview of `landing/dist/server/wrangler.json` serves the last build and requires rebuilding after changes.

## 1. Provision D1 and Turnstile

1. Authenticate locally with `node scripts/run-wrangler.mjs login`, then run `node scripts/run-wrangler.mjs d1 create pomegr-waitlist`.
2. Replace the all-zero placeholder `database_id` in `landing/wrangler.jsonc` with the returned database ID.
3. Apply the schema with `npm run db:migrate:remote`. D1 is the only waitlist data store; rejected requests do not write to it.
4. Create a Turnstile widget for `pomegr.com`. Replace `REPLACE_WITH_TURNSTILE_SITE_KEY` in `landing/wrangler.jsonc`; the site key is intentionally public.
5. Store secrets interactively. They are never bundled for the browser:

   ```powershell
   node scripts/run-wrangler.mjs secret put TURNSTILE_SECRET_KEY
   node scripts/run-wrangler.mjs secret put WAITLIST_COOKIE_SECRET
   ```

   Generate the cookie secret with a cryptographically secure password generator and use at least 32 random bytes. Do not set `WAITLIST_ALLOW_LOCAL_DEV` in production.

There is no public administration route. Inspect or export signups only through authenticated Wrangler/D1 commands. Never add IP addresses to the schema or logs.

## 2. Preserve mail while moving DNS

Namecheap remains the registrar. Before changing nameservers:

1. Export or copy every existing Namecheap DNS record, especially the `eforward1` through `eforward5.registrar-servers.com` MX records and the existing SPF TXT record.
2. Add `pomegr.com` to Cloudflare and reproduce those MX/TXT records exactly. Mail records must be DNS-only, not proxied.
3. Remove the Namecheap parking A record and parking-page `www` CNAME after the equivalent Cloudflare records are ready.
4. At Namecheap, replace the authoritative nameservers with the two Cloudflare nameservers assigned to the zone.
5. Wait until Cloudflare reports the zone active, then verify MX and SPF resolution and send a real forwarding test in both directions.

Cloudflare Universal SSL supplies and renews the public TLS certificate without a separate certificate purchase. Keep SSL/TLS mode on Full (strict) where applicable and enable Always Use HTTPS.

## 3. Domain routes and public boundary

`landing/wrangler.jsonc` attaches the Worker to both `pomegr.com` and `www.pomegr.com`. The Worker redirects `www` to the HTTPS apex with status 308. Its final configuration has `workers_dev` and preview URLs disabled.

For local validation, use the development instructions above; use a temporary reviewed staging configuration for deployment validation. Do not leave a production `workers.dev` route enabled. The Worker allowlist admits only `/`, `/about`, `/download`, `/docs`, the two waitlist endpoints, and the landing's explicit static asset paths and prefixes. The `/docs/` prefix covers every documentation page and the copied page images under `/docs/images/`. It is exact: `/docs` and paths that begin `/docs/` pass; `/docsx`, `/docs..`, `/Docs`, `/docs%2F...`, and `/x/docs/...` do not, and a path such as `/docs/../dashboard` is normalized to `/dashboard` and rejected. Local routes such as `/dashboard`, `/api/state`, and `/api/sessions` return 404 before the application router.

The documentation routes are the application's, not the Worker's. `/docs` redirects (307) to the manifest's first page, an exact group path such as `/docs/concepts` redirects (307) to that group's first page, and the catch-all `/docs/<group>/<topic>` route serves only pages the [publication manifest](../development/documentation-manifest.md#serve-the-pages) selects. An unknown `/docs/...` path passes the allowlist on purpose and receives the application's 404 page, which keeps the documentation navigation; only paths outside the allowlist get the Worker's plain `Not found`. Adding a page therefore never needs an allowlist change.

`/sitemap.xml` and `/robots.txt` are application routes (`landing/app/sitemap.ts` and `landing/app/robots.ts`), not static files, and the Worker admits both paths. The sitemap is built from the same generated content revision as the pages and the docs search index: it lists `/`, `/about`, `/download`, and the published documentation pages on `https://pomegr.com`, never `/docs`, `/docs/images/`, the API, or an unpublished path. `robots.txt` allows everything and names only the sitemap location. See [Search, sitemap, and robots](../development/documentation-manifest.md#search-sitemap-and-robots).

## 4. Edge and application rate limits

The application binding `WAITLIST_RATE_LIMITER` allows five attempts per Cloudflare client-IP key per 60 seconds. The key is used ephemerally and is never stored. Keep that binding in every production environment.

Also create the single free WAF rate-limiting rule in **Security → WAF → Rate limiting rules**:

- Match request paths beginning with `/api/waitlist`.
- Count by source IP.
- Threshold: 5 requests in 10 seconds.
- Mitigation: Managed Challenge, or Block if challenge behavior is unsuitable.
- Apply the mitigation to all methods and keep the response generic.

The WAF rule is a coarse outer shield. Same-origin browser headers, the honeypot, the Worker limiter, and single-use Turnstile validation remain required because request headers alone can be forged.

## 5. Release the exact audited artifact

### Manual GitHub deployment

The [Deploy landing workflow](../../../.github/workflows/deploy-landing.yml) runs only
through `workflow_dispatch`; pushes, pull requests, and tags do not deploy the site.
It installs the landing lockfile, checks the documentation (`npm run check:docs` from the
repository root), runs landing tests and typechecking, builds and audits once, then
deploys that exact artifact with the existing `deploy` script.
Production deployments are serialized without cancelling an active deployment.

Before the first run:

1. Merge the workflow onto the default branch (`main`) so GitHub displays its
   **Run workflow** button.
2. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets,
   either in the `landing-production` environment or at repository scope. Use a
   token scoped to the production Cloudflare account and zone with the permissions
   required to deploy this Worker and its configured bindings/custom domains;
   follow [Cloudflare's GitHub Actions setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
3. Complete the production provisioning in sections 1-4. The workflow uses existing
   D1 bindings and Worker secrets; schema migrations and secret provisioning remain
   separate operator actions.

In GitHub, open **Actions → Deploy landing → Run workflow**, select the branch to
deploy (normally `main`), and run it. The workflow deploys the selected ref's commit
to `https://pomegr.com`. Environment protection rules, if configured for
`landing-production`, apply before the job starts. See
[GitHub's manual workflow instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

From the repository checkout, the equivalent dispatch is:

```powershell
gh workflow run deploy-landing.yml --ref main
```

After a successful run, perform the smoke checks below.

### Local deployment

Run this block from the repository root (`C:\Workspace\repos\Pomegr` for the local checkout):

```powershell
npm --prefix landing ci
npm run check:docs
npm --prefix landing test
npm --prefix landing run typecheck
npm --prefix landing run build:audit
npm --prefix landing run deploy
```

`check:docs` belongs to the root `package.json` and needs only the landing dependencies installed above. `build:audit` and `deploy` belong to `landing/package.json`. Running `npm run build:audit` from the repository root produces `Missing script: "build:audit"`. If your terminal is already inside `landing/`, omit `--prefix landing` from the commands above.

Do not edit `landing/dist` between the audit and deployment. `npm run deploy` re-runs the audit immediately before invoking `wrangler deploy --config dist/server/wrangler.json`; that generated configuration (paths relative to `landing/`) uses `dist/server/index.js` with `no_bundle: true` and serves assets only from `dist/client`.

After deployment, smoke-test:

- HTTPS `/`, `/about`, and `/download` return 200 and `www` redirects to the apex.
- The documentation pages, images, search, sitemap, `robots.txt`, and unknown-path 404 pass the [documentation smoke checks](#documentation-smoke-checks).
- The download page shows version and file sizes, and its installer/portable buttons point directly to the corresponding official GitHub `.exe` assets.
- `/dashboard`, `/api/state`, `/api/sessions`, and random paths return 404.
- Signup, a duplicate signup, the signed status cookie, Turnstile failure, and throttling behave as expected.
- The D1 row contains only the expected normalized fields and duplicates do not overwrite the first row.
- Email forwarding still works and the public Worker has no `workers.dev` route.

### Download release lookup

The download page queries GitHub's latest stable release and allows a 15-minute
Cloudflare response cache. Requests use `redirect: "manual"` because workerd
rejects `"error"`; non-OK responses, including redirects, use the verified fallback
in `landing/server/download-release.ts`. Keep that fallback's version and asset sizes in
sync with a verified published release when updating it. The landing test suite
includes a workerd regression test for successful lookup and rejected redirects.

## 6. Publish documentation

The public documentation at `/docs` is built into the landing artifact from the repository, so publishing it is an ordinary website deployment ([section 5](#5-release-the-exact-audited-artifact)) and never part of desktop packaging. This section defines where the content comes from, what validates it, and what each kind of documentation change needs.

### Where the content comes from

- `docs/site.json` selects the public pages (`docs/public/<group>/<topic>.md`) in reading order. A file under `docs/public/` that the manifest does not select is never published; `check:docs` reports it as `unselected-page`, so a draft cannot sit there unnoticed. Keep drafts in an active plan.
- The landing loader (`landing/scripts/docs-content.mjs`) is the only code that reads outside `landing/`, and it reads only the manifest and the pages and images the manifest selects. It writes the gitignored `landing/generated/` content and search index and the `landing/public/docs/` images. The Worker bundles the generated JSON and never reads files.
- Internal documentation, plans, mockups, and unselected files cannot become a page, an asset, a search entry, or a sitemap entry, even through a mistaken manifest entry: the loader rejects such a path or a link to it; `audit:source` and `audit:artifact` reject non-public paths and unexpected files; and [`docs-exclusion.test.ts`](../../../landing/tests/ui/docs-exclusion.test.ts) and [`docs-artifact.test.ts`](../../../landing/tests/ui/docs-artifact.test.ts) prove it with canary content in a fixture repository, including a real build. See the [publication boundary](../development/documentation-manifest.md#enforce-the-publication-boundary).
- The site publishes the checkout that is built. The Deploy landing workflow builds the ref you select; a local deployment builds your working tree, so commit and review documentation changes first.

### Validation order

1. `npm run check:docs` from the repository root applies the loader's own rules to the public pages, then the public-tree, public-boundary, and maintained-link rules. It is part of `npm run check`, so it runs in `verify:fast`, in `verify` (the Windows verification and desktop release workflows), and as the first step after dependency installation in the Deploy landing workflow. It needs only `npm ci --prefix landing`; exit code 2 means the landing dependencies are missing.
2. `docs:prepare` in `landing/` applies the same loader before `dev`, `test`, `typecheck`, and `build`. Invalid content stops the command with every problem listed, so `build` and `build:audit` fail before the bundler runs and no artifact is produced.
3. `audit:source` runs at the start of `build`, and `audit:artifact` runs after it and again inside `deploy`. They check the generated content and search index against each other, compare the mirrored images with the built copies byte for byte, and scan the built output, including image bytes, for non-public, repository, and home-directory paths. `deploy` does not regenerate documentation, so do not edit documentation or `landing/dist` between `build:audit` and `deploy`.

### What a change needs

| Change | Validate | Website deployment |
| --- | --- | --- |
| Internal documentation only (`docs/internal/**`, plans, root Markdown, skill packages) | `npm run check:docs`, plus the checks for any code you touched | None. Internal pages never ship, and merging them changes nothing on pomegr.com. |
| A public page or image that `docs/site.json` selects, or an edit to `docs/site.json` | `npm run check:docs`, then the landing test, typecheck, and `build:audit` (the workflow runs them) | Required before the change appears: run the Deploy landing workflow. |
| Landing code (`landing/app`, `worker`, `server`, `scripts`) | Landing test, typecheck, and `build:audit` | Required. |
| A desktop release | [Desktop releases](desktop-releases.md) | Not part of it. A release does not deploy the site, and a site deployment does not package the app. If a release changes behavior that a public page describes, publish that page as its own website deployment once the release is available. |

### Documentation smoke checks

After a deployment that changes documentation, check `https://pomegr.com` at desktop width and at about 390 px, where the documentation menu replaces the sidebar:

- **Pages:** `/docs` redirects to the first documentation page, and each group path (`/docs/get-started`, `/docs/using-pomegr`, `/docs/concepts`, `/docs/help`) redirects (307) to that group's first page. Each changed page returns 200 with its sidebar (current page marked), outline, and previous/next links.
- **Images:** each changed screenshot displays, and a `/docs/images/<topic>/<file>.jpg` URL returns 200 with an image type.
- **Search:** typing a changed heading in the sidebar field lists its page with a link to that heading, and choosing it opens the page. A word found only in internal documentation finds nothing.
- **Sitemap:** `/sitemap.xml` returns XML listing exactly `/`, `/about`, `/download`, and the published pages on `https://pomegr.com`, as many pages as the manifest selects, and no `/docs`, image, API, or internal path.
- **Robots:** `/robots.txt` returns plain text with `Allow: /` and only the `Sitemap: https://pomegr.com/sitemap.xml` line.
- **404:** `/docs/not-a-page` and an internal-looking path such as `/docs/internal/architecture/overview` return status 404 with the documentation navigation. `/dashboard` and `/api/state` return the Worker's plain 404.

### Automation triggers (proposal, not enabled)

The release policy is explicit manual dispatch: `deploy-landing.yml` and `release.yml` run only through `workflow_dispatch`, and neither a merge nor a tag push releases anything. Documentation keeps that policy. No trigger has been added, and `deploy-landing.yml` stays `workflow_dispatch`. The only automatic documentation step is validation: Windows verification runs `npm run verify`, including `check:docs`, for every pull request to `main` and every push to it, and deploys nothing.

Options for the owner, in order of preference:

1. **Stay manual (current).** Dispatch the workflow after a public-documentation change merges, and record the deployed ref in the pull request.
2. **Release-coupled.** Add "publish pending public documentation" to the desktop [release checklist](desktop-releases.md#release-checklist) as a separate manual dispatch after the release is available.
3. **Approval-gated push.** Add a `push` trigger on `main` filtered to `docs/public/**`, `docs/site.json`, and `landing/**`, with required reviewers on the `landing-production` environment so the job waits for a person before it deploys.

Do not enable option 3 before the environment approval exists, the smoke checks above are either automated after deployment or accepted as a manual gate, the first publication (WEB-07) has been deployed by hand, and a rollback has been rehearsed. Changing a trigger is a separate, reviewed change that updates this section and the workflow together.

## 7. Rollback

Use Cloudflare Worker Versions & Deployments (or authenticated Wrangler rollback) to promote the previously known-good Worker version. D1 is independent: never delete, recreate, or reverse waitlist rows during an application rollback. Apply future schema migrations forward and separately from Worker version rollback.

For data recovery, export D1 before a risky schema migration. Application rollback is not a database rollback.

A documentation-only problem, such as wrong page text or a wrong screenshot, is fixed by correcting the source and deploying again. When a page must disappear immediately, promote the previous Worker version; it carries the previous documentation revision.
