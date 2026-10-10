import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWebBuildSnapshot } from "../desktop/runtime/web-build-snapshot.mjs";

async function checkout() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-web-snapshot-"));
  await mkdir(path.join(root, "dist", "client", "assets"), { recursive: true });
  await writeFile(path.join(root, "dist", "client", "assets", "index-old.css"), "body {}\n");
  return root;
}

test("an unpackaged web build is served from a copy a later build cannot change", async () => {
  const root = await checkout();
  const processTarget = new EventEmitter();
  try {
    const outDir = await createWebBuildSnapshot(root, { pid: 41, isRunning: () => false, processTarget });
    assert.equal(outDir, path.join(root, ".wrangler", "desktop-web", "41", "dist"));

    await rm(path.join(root, "dist"), { recursive: true });
    assert.equal(await readFile(path.join(outDir, "client", "assets", "index-old.css"), "utf8"), "body {}\n");

    processTarget.emit("exit");
    assert.equal(existsSync(path.dirname(outDir)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a start removes only the copies of processes that no longer run", async () => {
  const root = await checkout();
  const parent = path.join(root, ".wrangler", "desktop-web");
  try {
    for (const name of ["7", "8", "41", "notes"]) await mkdir(path.join(parent, name, "dist"), { recursive: true });
    await writeFile(path.join(parent, "41", "dist", "stale.css"), "");
    const outDir = await createWebBuildSnapshot(root, { pid: 41, isRunning: (pid) => pid === 8, processTarget: new EventEmitter() });
    assert.deepEqual(["7", "8", "41", "notes"].map((name) => existsSync(path.join(parent, name))), [false, true, true, true]);
    assert.equal(existsSync(path.join(outDir, "stale.css")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing build fails with one fixed code and leaves no copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-web-snapshot-"));
  try {
    await assert.rejects(
      createWebBuildSnapshot(root, { pid: 41, isRunning: () => false, processTarget: new EventEmitter() }),
      (error) => error.message === "DESKTOP_WEB_SNAPSHOT_FAILED",
    );
    assert.equal(existsSync(path.join(root, ".wrangler", "desktop-web", "41")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
