import { rmSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

// Inside the checkout, so the copied server entry still resolves the checkout's packages.
const SNAPSHOT_PARENT = path.join(".wrangler", "desktop-web");

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// A private copy keeps a running server's hashed asset names together with its assets; stale copies are removed on the next start.
export async function createWebBuildSnapshot(applicationRoot, options = {}) {
  const pid = String(options.pid ?? process.pid);
  const isRunning = options.isRunning ?? processIsRunning;
  const parent = path.join(applicationRoot, SNAPSHOT_PARENT);
  const directory = path.join(parent, pid);
  const outDir = path.join(directory, "dist");
  const removeOnExit = () => {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* The next start removes it. */ }
  };
  try {
    await mkdir(parent, { recursive: true });
    for (const name of await readdir(parent)) {
      if (!/^\d+$/.test(name) || (name !== pid && isRunning(Number(name)))) continue;
      try {
        await rm(path.join(parent, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch { /* A leftover copy never blocks startup. */ }
    }
    (options.processTarget ?? process).once("exit", removeOnExit);
    await cp(path.join(applicationRoot, "dist"), outDir, { recursive: true });
  } catch {
    removeOnExit();
    throw new Error("DESKTOP_WEB_SNAPSHOT_FAILED");
  }
  return outDir;
}
