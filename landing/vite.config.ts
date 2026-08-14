import { cloudflare } from "@cloudflare/vite-plugin";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vinext from "vinext";
import { defineConfig } from "vite";

const landingRoot = fileURLToPath(new URL(".", import.meta.url));
const workerConfig = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
const configuredTurnstileSiteKey = workerConfig.vars?.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

function localTurnstileSiteKey() {
  const localVars = new URL("./.dev.vars", import.meta.url);
  if (!existsSync(localVars)) return "";
  const match = readFileSync(localVars, "utf8").match(/^NEXT_PUBLIC_TURNSTILE_SITE_KEY\s*=\s*(.+)$/mu);
  return match?.[1]?.trim().replace(/^(["'])(.*)\1$/u, "$2") ?? "";
}

// Keep local preview state inside this deployable package. The public build is
// intentionally unable to resolve source from Pomegr's local-only application.
process.env.WRANGLER_WRITE_LOGS ??= "false";
process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

export default defineConfig(({ mode }) => ({
  define: {
    __TURNSTILE_SITE_KEY__: JSON.stringify(
      mode === "development" ? localTurnstileSiteKey() || configuredTurnstileSiteKey : configuredTurnstileSiteKey,
    ),
  },
  resolve: {
    alias: {
      "@": landingRoot,
    },
  },
  server: {
    host: "127.0.0.1",
    fs: {
      strict: true,
      allow: [landingRoot],
    },
  },
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
}));
