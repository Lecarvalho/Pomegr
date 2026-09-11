import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", "electron", "dist", "electron");
const fixture = path.join(root, "tests", "perfetto-viewer-electron-fixture");

test("opt-in pinned Perfetto viewer imports a local trace without external requests", async (context) => {
  if (process.env.POMEGR_PERFETTO_ELECTRON_SMOKE !== "1") {
    context.skip("set POMEGR_PERFETTO_ELECTRON_SMOKE=1 to run the local Electron viewer smoke");
    return;
  }
  try { await access(executable); } catch { context.skip("Electron runtime is unavailable"); return; }
  const profile = await mkdtemp(path.join(os.tmpdir(), "pomegr-perfetto-viewer-electron-"));
  context.after(() => rm(profile, { recursive: true, force: true }));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const process = spawn(executable, ["--headless", "--disable-gpu", `--user-data-dir=${profile}`, fixture], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => { process.kill(); reject(new Error("Perfetto viewer smoke timed out")); }, 30_000);
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk) => { output += chunk; });
    process.once("error", (error) => { clearTimeout(timeout); reject(error); });
    process.once("exit", (code) => { clearTimeout(timeout); resolve({ code, output }); });
  });
  if (result.code === 0x80000003) {
    context.skip("managed Windows Electron renderer cannot initialize without relaxing its sandbox");
    return;
  }
  assert.equal(result.code, 0, `Perfetto viewer fixture exited ${result.code}`);
  const proof = JSON.parse(result.output.trim());
  assert.equal(proof.traceFileSelected, true, JSON.stringify(proof));
  assert.equal(proof.unexpectedExternalRequests, 0);
  // Perfetto clears the file input after accepted import. Its title is the
  // stable public proof that the local trace opened.
  assert.equal(proof.summary.traceNameVisible, true, JSON.stringify(proof));
  assert.equal(proof.summary.localViewerRoute, true);
});
