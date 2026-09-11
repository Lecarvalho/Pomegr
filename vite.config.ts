import vinext from "vinext";
import { defineConfig, type UserConfig } from "vite";
import path from "node:path";
import { vinextLanCompatibilityPlugin } from "./scripts/vinext-lan-compat.mjs";
import { providerFoldersLocalGatePlugin } from "./scripts/provider-folders-local-gate.mjs";
import { rendererTraceLocalGatePlugin } from "./scripts/renderer-trace-local-gate.mjs";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
};

export default defineConfig(async ({ command, mode }): Promise<UserConfig> => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  const developmentTrace = command === "serve" && mode !== "production";
  return {
    resolve: {
      alias: {
        "@pomegr/renderer-trace": path.resolve(developmentTrace ? "app/renderer-trace.ts" : "app/renderer-trace.inert.ts"),
        "@pomegr/renderer-trace-response": path.resolve(developmentTrace ? "app/renderer-trace-response.dev.ts" : "app/renderer-trace-response.inert.ts"),
        "#pomegr/renderer-trace-response": path.resolve(developmentTrace ? "app/renderer-trace-response.dev.ts" : "app/renderer-trace-response.inert.ts"),
      },
    },
    server: {
      // The dashboard is intentionally reachable through this machine's LAN IP.
      allowedHosts: true,
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      providerFoldersLocalGatePlugin(),
      rendererTraceLocalGatePlugin(),
      vinextLanCompatibilityPlugin(),
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
