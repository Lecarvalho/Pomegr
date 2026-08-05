import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [
  spawn(process.execPath, [path.join(root, "monitor", "server.mjs")], { cwd: root, stdio: "inherit" }),
  spawn(process.execPath, [path.join(root, "scripts", "run-vinext.mjs"), "dev", "--hostname", "0.0.0.0", "--port", "3003"], { cwd: root, stdio: "inherit" }),
];

let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 80).unref();
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!closing && code && code !== 0) close(code);
  });
}
process.on("SIGINT", () => close(0));
process.on("SIGTERM", () => close(0));
