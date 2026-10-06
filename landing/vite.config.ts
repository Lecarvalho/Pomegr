import { cloudflare } from "@cloudflare/vite-plugin";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";

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

// With a deployment ID (`next.config.ts`), vinext renders every built URL as a hashed asset, so a
// stylesheet's `url("/fonts/...")` to a file in `public/` becomes `/_next/static/fonts/...`, which
// does not exist. Files in `public/` keep their own address: `undefined` selects Vite's default.
function keepPublicFileUrls(): Plugin {
  return {
    name: "pomegr:keep-public-file-urls",
    configResolved(config) {
      const render = config.experimental.renderBuiltUrl;
      if (!render) return;
      config.experimental.renderBuiltUrl = (filename, context) => (context.type === "public" ? undefined : render(filename, context));
    },
  };
}

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
    keepPublicFileUrls(),
    cloudflare({
      // Local development must not open OAuth or connect to the production D1 database.
      remoteBindings: false,
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
}));
