import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "dev";
const child = spawn(process.execPath, [path.join(root, "node_modules", "vinext", "dist", "cli.js"), command, ...process.argv.slice(3)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, WRANGLER_LOG_PATH: path.join(root, ".wrangler", "wrangler.log") },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
