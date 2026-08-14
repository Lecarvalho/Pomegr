import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const landingRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(readFileSync(resolve(landingRoot, "wrangler.jsonc"), "utf8"));
const databaseId = config.d1_databases?.find((binding) => binding.binding === "DB")?.database_id;
const siteKey = config.vars?.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const failures = [];

if (!databaseId || /^0{8}-0{4}-[04]000-8000-0{12}$/.test(databaseId)) {
  failures.push("replace the all-zero D1 database_id in wrangler.jsonc");
}
if (!siteKey || siteKey.startsWith("REPLACE_WITH_")) {
  failures.push("replace NEXT_PUBLIC_TURNSTILE_SITE_KEY in wrangler.jsonc");
}
if (config.workers_dev !== false || config.preview_urls !== false) {
  failures.push("workers_dev and preview_urls must both be false for production");
}
for (const secret of ["TURNSTILE_SECRET_KEY", "WAITLIST_COOKIE_SECRET"]) {
  if (secret in (config.vars ?? {})) failures.push(`${secret} must be a Worker secret, not a plaintext var`);
}

if (failures.length) {
  console.error("Production configuration is not ready:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("production binding configuration verified");
}
