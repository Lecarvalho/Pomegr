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
const fixture = path.join(root, "tests", "renderer-trace-react-electron-fixture");

test("opt-in Electron renders the real activity history hook and safely enriches one row", async (context) => {
  if (process.env.POMEGR_RENDERER_REACT_ELECTRON_SMOKE !== "1") {
    context.skip("set POMEGR_RENDERER_REACT_ELECTRON_SMOKE=1 to run the real renderer history smoke");
    return;
  }
  try { await access(executable); } catch { context.skip("Electron runtime is unavailable"); return; }
  const profile = await mkdtemp(path.join(os.tmpdir(), "pomegr-renderer-trace-react-electron-"));
  context.after(() => rm(profile, { recursive: true, force: true }));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const proof = await new Promise((resolve, reject) => {
    const child = spawn(executable, ["--headless", "--disable-gpu", `--user-data-dir=${profile}`, fixture], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let pending = "";
    let complete = null;
    const timeout = setTimeout(() => { child.kill(); reject(new Error("renderer history smoke timed out")); }, 30_000);
    const consume = (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === "initial" && typeof message.origin === "string") {
        void fetch(`${message.origin}/release`, { method: "POST" }).catch(reject);
      }
      if (message.type === "complete") complete = message.proof;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) consume(line);
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0x80000003) { resolve({ skipped: true }); return; }
      if (code !== 0) { reject(new Error(`renderer history fixture exited ${code}`)); return; }
      resolve(complete);
    });
  });
  if (proof?.skipped) {
    context.skip("managed Windows Electron renderer cannot initialize without relaxing its sandbox");
    return;
  }
  assert.ok(proof, "renderer history fixture did not return proof");
  assert.equal(proof.initialVisible, true, JSON.stringify(proof));
  assert.equal(proof.sameNodeEnriched, true, JSON.stringify(proof));
  assert.deepEqual(proof.rendererStages, ["renderer_event", "renderer_fetch", "renderer_next_frame", "renderer_react_commit"]);
  assert.ok(proof.rendererPosts >= 1, JSON.stringify(proof));
  assert.equal(proof.rejectedRendererPosts, 0, JSON.stringify(proof));
  assert.ok(proof.maxRendererCalibrationRttMs >= 0 && proof.maxRendererCalibrationRttMs <= 1_000, JSON.stringify(proof));
  assert.equal(proof.unexpectedExternalRequests, 0, JSON.stringify(proof));
});
