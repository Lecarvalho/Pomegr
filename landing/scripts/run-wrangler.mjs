import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const landingRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const wrangler = resolve(
  dirname(require.resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);
const environment = {
  ...process.env,
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: resolve(landingRoot, ".wrangler", "logs"),
  XDG_CONFIG_HOME: resolve(landingRoot, ".wrangler", "config"),
};
const result = spawnSync(process.execPath, [wrangler, ...process.argv.slice(2)], {
  cwd: landingRoot,
  env: environment,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
