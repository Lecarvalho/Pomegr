import { spawnSync } from "node:child_process";
import { captureClaudeStatuslineCost } from "../monitor/session-cost.mjs";

const chunks = [];
let size = 0;
let captureAllowed = true;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 1_000_000) captureAllowed = false;
  chunks.push(chunk);
}
const input = Buffer.concat(chunks).toString("utf8");

try {
  if (captureAllowed) captureClaudeStatuslineCost(JSON.parse(input));
} catch {
  // Cost capture must never interfere with the user's status line.
}

const separator = process.argv.indexOf("--");
const delegate = separator >= 0 ? process.argv.slice(separator + 1) : [];
if (delegate.length > 0) {
  const result = spawnSync(delegate[0], delegate.slice(1), {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1_000_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) process.exit(1);
  process.exit(result.status ?? 0);
}
