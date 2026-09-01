import { spawnSync } from "node:child_process";
import { captureClaudeStatuslineCost } from "../monitor/session-cost.mjs";
import { captureClaudeStatuslineUsage } from "../monitor/providers/claude-usage-feed.mjs";

async function main() {
  const chunks = [];
  let size = 0;
  let captureAllowed = true;
  for await (const chunk of process.stdin) {
    if (!captureAllowed || size + chunk.length > 1_000_000) {
      captureAllowed = false;
      chunks.length = 0;
      size = 0;
      continue;
    }
    size += chunk.length;
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8");

  try {
    if (captureAllowed) {
      const statusline = JSON.parse(input);
      try { captureClaudeStatuslineCost(statusline); } catch { /* Cost capture is isolated. */ }
      try { captureClaudeStatuslineUsage(statusline); } catch { /* Usage capture is isolated. */ }
    }
  } catch {
    // Local observation capture must never interfere with the user's status line.
  }

  const separator = process.argv.indexOf("--");
  const delegate = separator >= 0 ? process.argv.slice(separator + 1) : [];
  if (delegate.length > 0) {
    const result = spawnSync(delegate[0], delegate.slice(1), {
      input,
      windowsHide: true,
      maxBuffer: 1_000_000,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) process.exit(1);
    process.exit(result.status ?? 0);
  }
}

void main().catch(() => { process.exitCode = 1; });
