# Landing operations

These steps publish only the public landing Worker. Run all commands from `landing/`; never deploy from the repository root.

## 1. Provision D1 and Turnstile

1. Authenticate locally with `node scripts/run-wrangler.mjs login`, then run `node scripts/run-wrangler.mjs d1 create pomegr-waitlist`.
2. Replace the all-zero placeholder `database_id` in `wrangler.jsonc` with the returned database ID.
3. Apply the schema with `npm run db:migrate:remote`. D1 is the only waitlist data store; rejected requests do not write to it.
4. Create a Turnstile widget for `pomegr.com`. Replace `REPLACE_WITH_TURNSTILE_SITE_KEY` in `wrangler.jsonc`; the site key is intentionally public.
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

`wrangler.jsonc` attaches the Worker to both `pomegr.com` and `www.pomegr.com`. The Worker redirects `www` to the HTTPS apex with status 308. Its final configuration has `workers_dev` and preview URLs disabled.

For first validation, use `node scripts/run-wrangler.mjs dev` or a temporary reviewed staging configuration. Do not leave a production `workers.dev` route enabled. The Worker allowlist admits only `/`, `/about`, the two waitlist endpoints, and the landing's explicit static asset paths. Local routes such as `/dashboard`, `/api/state`, and `/api/sessions` return 404 before the application router.

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

```powershell
npm ci
npm test
npm run typecheck
npm run build:audit
npm run deploy
```

Do not edit `dist` between the audit and deployment. `npm run deploy` re-runs the audit immediately before invoking `wrangler deploy --config dist/server/wrangler.json`; that generated configuration uses `dist/server/index.js` with `no_bundle: true` and serves assets only from `dist/client`.

After deployment, smoke-test:

- HTTPS `/` and `/about` return 200 and `www` redirects to the apex.
- `/dashboard`, `/api/state`, `/api/sessions`, and random paths return 404.
- Signup, a duplicate signup, the signed status cookie, Turnstile failure, and throttling behave as expected.
- The D1 row contains only the expected normalized fields and duplicates do not overwrite the first row.
- Email forwarding still works and the public Worker has no `workers.dev` route.

## 6. Rollback

Use Cloudflare Worker Versions & Deployments (or authenticated Wrangler rollback) to promote the previously known-good Worker version. D1 is independent: never delete, recreate, or reverse waitlist rows during an application rollback. Apply future schema migrations forward and separately from Worker version rollback.

For data recovery, export D1 before a risky schema migration. Application rollback is not a database rollback.
