import { captureCodexLifecycleHook } from "../monitor/providers/codex-liveness.mjs";

/**
 * Consume one Codex lifecycle payload without changing the hook's response.
 * A plugin may supply a colocated owner watcher while the standalone bridge
 * keeps the monitor-owned default watcher.
 */
export async function runCodexLifecycleBridge({ launchWatcher, ownerWatcherPath } = {}) {
  const chunks = [];
  let size = 0;
  let allowed = true;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1_000_000) allowed = false;
    if (allowed) chunks.push(chunk);
  }

  try {
    if (allowed) {
      captureCodexLifecycleHook(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
        ...(typeof launchWatcher === "function" ? { launchWatcher } : {}),
        ...(typeof ownerWatcherPath === "string" ? { ownerWatcherPath } : {}),
      });
    }
  } catch {
    // Observation must never interfere with Codex lifecycle handling.
  }

  // Stop and SubagentStop require JSON on successful hook completion. An
  // empty object is also inert for every other supported hook event.
  process.stdout.write("{}\n");
}
