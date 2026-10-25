import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { withProductionBuildLock } from "./production-build-lock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "dev";
const filterRequestLog = command === "dev" && process.env.POMEGR_DEV_REQUEST_LOG !== "all";

function isNoContentRequest(line) {
  const plain = stripVTControlCharacters(line);
  return /^\s+[A-Z]+\s+\S+\s+204\s+in(?:\s|$)/.test(plain);
}

const run = () => new Promise((resolve, reject) => {
  const env = { ...process.env, WRANGLER_LOG_PATH: path.join(root, ".wrangler", "wrangler.log") };
  if (command === "dev" && process.stdout.isTTY && env.FORCE_COLOR == null) env.FORCE_COLOR = "1";
  const child = spawn(process.execPath, [path.join(root, "node_modules", "vinext", "dist", "cli.js"), command, ...process.argv.slice(3)], {
    cwd: root,
    stdio: filterRequestLog ? ["inherit", "pipe", "inherit"] : "inherit",
    env,
    windowsHide: true,
  });
  child.once("error", reject);
  if (filterRequestLog) {
    child.stdout.setEncoding("utf8");
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (!isNoContentRequest(line)) process.stdout.write(line);
      }
    });
    child.once("close", (code, signal) => {
      if (pending && !isNoContentRequest(pending)) process.stdout.write(pending);
      process.stdout.write("", () => resolve({ code, signal }));
    });
  } else {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }
});

const { code, signal } = await (command === "build" ? withProductionBuildLock(root, run) : run());
if (signal) process.kill(process.pid, signal);
process.exit(code ?? 0);
