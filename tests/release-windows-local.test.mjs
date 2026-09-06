import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureReleaseNodeRuntime } from "../scripts/release-node-runtime.mjs";

import {
  parseReleaseArguments,
  releaseWorkflowNodeVersion,
  resolveNpmCli,
  runReleaseCli,
  spawnCommand,
  validateThenDispatchRelease,
} from "../scripts/release-windows-local.mjs";

const TAG = "v1.2.3";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const NPM_CLI = "C:/node/node_modules/npm/bin/npm-cli.js";
const WORKFLOW = "node-version: 22.13.0\n";

function fixture({ fail, dirtyAt, headAt, localTagAt, remoteTagAt, annotated = false, remoteMissing = false } = {}) {
  const calls = [];
  let pointChecks = 0;
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    const label = command === process.execPath ? `npm ${args.slice(1).join(" ")}` : `${command} ${args.join(" ")}`;
    if (fail === label) throw new Error("fixture failure");
    if (command === "git" && args[0] === "status") {
      pointChecks += 1;
      return { stdout: dirtyAt === pointChecks ? " M package.json\n" : "" };
    }
    if (command === "git" && args[0] === "rev-parse") {
      const isHead = args[1] === "HEAD";
      const value = isHead ? (headAt === pointChecks ? OTHER_SHA : SHA) : (localTagAt === pointChecks ? OTHER_SHA : SHA);
      return { stdout: `${value}\n` };
    }
    if (command === "gh" && args[0] === "api" && args.at(-1).includes("/git/ref/tags/")) {
      if (remoteMissing) return { stdout: "{}" };
      return { stdout: JSON.stringify({ object: { type: annotated ? "tag" : "commit", sha: remoteTagAt === pointChecks ? OTHER_SHA : SHA } }) };
    }
    if (command === "gh" && args[0] === "api" && args.at(-1).includes("/git/tags/")) {
      return { stdout: JSON.stringify({ object: { type: "commit", sha: remoteTagAt === pointChecks ? OTHER_SHA : SHA } }) };
    }
    return { stdout: "" };
  };
  return { calls, runCommand };
}

function runFixture(options = {}) {
  const source = fixture(options);
  return {
    source,
    result: validateThenDispatchRelease({
      tag: TAG,
      platform: "win32",
      nodeVersion: "v22.13.0",
      npmExecPath: NPM_CLI,
      readText: async (filename) => filename.endsWith("package.json") ? JSON.stringify({ version: "1.2.3" }) : WORKFLOW,
      runCommand: source.runCommand,
      ...options,
    }),
  };
}

function dispatches(calls) {
  return calls.filter(({ command, args }) => command === "gh" && args[0] === "workflow");
}

test("release CLI arguments and workflow node pin fail closed", () => {
  assert.deepEqual(parseReleaseArguments(["--tag", TAG, "--check-only"]), { tag: TAG, checkOnly: true, help: false });
  assert.deepEqual(parseReleaseArguments(["--help"]), { help: true });
  for (const args of [[], ["--tag"], ["--tag", TAG, "--tag", TAG], ["--unknown"]]) {
    assert.throws(() => parseReleaseArguments(args), /POMEGR_RELEASE_/);
  }
  assert.equal(releaseWorkflowNodeVersion(WORKFLOW), "22.13.0");
  assert.throws(() => resolveNpmCli("C:/not-npm/cli.js"), /NPM_ENTRY_INVALID/);
});

test("successful preflight dispatches the tag-bound release workflow exactly once", async () => {
  const { source, result } = runFixture();
  assert.deepEqual(await result, { tag: TAG, version: "1.2.3", dispatched: true });
  assert.deepEqual(dispatches(source.calls), [{
    command: "gh",
    args: ["workflow", "run", "release.yml", "--repo", "https://github.com/Lecarvalho/Pomegr", "--ref", TAG, "-f", `tag=${TAG}`],
  }]);
  const npmCalls = source.calls.filter(({ command }) => command === process.execPath);
  assert.deepEqual(npmCalls.map(({ args }) => args.slice(1)), [
    ["ci"], ["ci", "--prefix", "landing"], ["run", "desktop:runtime"], ["run", "verify"], ["run", "verify:desktop:ci"],
  ]);
});

test("every failed preflight gate blocks dispatch", async () => {
  for (const failure of [
    "gh auth status --hostname github.com",
    "gh api --hostname github.com --method GET repos/Lecarvalho/Pomegr",
    "git status --porcelain=v1 --untracked-files=all",
    `git rev-parse refs/tags/${TAG}^{commit}`,
    "npm ci",
    "npm ci --prefix landing",
    "npm run desktop:runtime",
    "npm run verify",
    "npm run verify:desktop:ci",
  ]) {
    const { source, result } = runFixture({ fail: failure });
    await assert.rejects(result, /fixture failure/);
    assert.equal(dispatches(source.calls).length, 0, failure);
    if (failure.startsWith("npm ")) {
      const lastGate = source.calls.filter(({ command }) => command === process.execPath).at(-1);
      assert.equal(`npm ${lastGate.args.slice(1).join(" ")}`, failure, "later gates must not run");
    }
  }
});

test("tag, platform, node, and remote resolution mismatches fail before dispatch", async () => {
  const wrongTag = fixture();
  await assert.rejects(validateThenDispatchRelease({
    tag: "v1.2.4", platform: "win32", nodeVersion: "v22.13.0", npmExecPath: NPM_CLI,
    readText: async () => JSON.stringify({ version: "1.2.3" }), runCommand: wrongTag.runCommand,
  }), /TAG_VERSION_MISMATCH/);
  assert.equal(dispatches(wrongTag.calls).length, 0);
  const node = fixture();
  await assert.rejects(validateThenDispatchRelease({
    tag: TAG, platform: "win32", nodeVersion: "v22.14.0", npmExecPath: NPM_CLI,
    readText: async (filename) => filename.endsWith("package.json") ? JSON.stringify({ version: "1.2.3" }) : WORKFLOW,
    runCommand: node.runCommand,
  }), /NODE_VERSION_MISMATCH/);
  assert.equal(node.calls.length, 0);
  const remote = runFixture({ remoteTagAt: 1, annotated: true });
  await assert.rejects(remote.result, /REMOTE_TAG_MISMATCH/);
  assert.equal(dispatches(remote.source.calls).length, 0);
  const missing = runFixture({ remoteMissing: true });
  await assert.rejects(missing.result, /REMOTE_TAG_INVALID/);
  assert.equal(dispatches(missing.source.calls).length, 0);
  await assert.rejects(validateThenDispatchRelease({ tag: TAG, platform: "linux" }), /WINDOWS_REQUIRED/);
  await assert.rejects(validateThenDispatchRelease({ tag: TAG, platform: "win32", arch: "arm64" }), /WINDOWS_X64_REQUIRED/);
});

test("post-validation edits or moved tags block dispatch, and check-only stays local", async () => {
  for (const options of [{ dirtyAt: 2 }, { headAt: 2 }, { localTagAt: 2 }, { remoteTagAt: 2, annotated: true }]) {
    const { source, result } = runFixture(options);
    await assert.rejects(result, /POMEGR_RELEASE_(CHECKOUT_DIRTY|HEAD_MOVED|LOCAL_TAG_MISMATCH|REMOTE_TAG_MISMATCH)/);
    assert.equal(dispatches(source.calls).length, 0);
  }
  const { source, result } = runFixture({ checkOnly: true });
  assert.deepEqual(await result, { tag: TAG, version: "1.2.3", dispatched: false });
  assert.equal(dispatches(source.calls).length, 0);
});

test("annotated remote tags resolve to their target commit", async () => {
  const { source, result } = runFixture({ annotated: true });
  assert.equal((await result).dispatched, true);
  assert.equal(dispatches(source.calls).length, 1);
});

test("captured child output is returned and a nonzero child includes bounded stderr", async () => {
  const success = await spawnCommand(process.execPath, ["-e", "process.stdout.write('captured output')"], { capture: true });
  assert.equal(success.stdout, "captured output");
  await assert.rejects(
    spawnCommand(process.execPath, ["-e", "process.stderr.write('x'.repeat(2 * 1024 * 1024) + 'final diagnostic', () => process.exit(7))"], { capture: true }),
    (error) => {
      assert.match(error.message, /POMEGR_RELEASE_COMMAND_FAILED/);
      assert.match(error.message, /\nx+final diagnostic$/);
      assert.equal(error.message.split("\n").at(-1).length, 2_048);
      return true;
    },
  );
});

test("a different default Node relaunches with the pinned executable and preserves check-only", async () => {
  const calls = [];
  const args = ["--tag", TAG, "--check-only"];
  await runReleaseCli(args, {
    nodeVersion: "v24.14.0", platform: "win32", arch: "x64", bootstrapped: false,
    readText: async () => WORKFLOW, report() {},
    ensureRuntime: async ({ version }) => {
      assert.equal(version, "22.13.0");
      return "C:/cached runtime/node.exe";
    },
    validate: async () => assert.fail("parent must not validate or dispatch with the wrong runtime"),
    runCommand: async (...call) => { calls.push(call); return { stdout: "" }; },
  });
  assert.equal(calls.length, 1);
  const [command, childArgs, options] = calls[0];
  assert.equal(command, "C:/cached runtime/node.exe");
  assert.deepEqual(childArgs.slice(1), args);
  assert.equal(options.nodeExecutable, command);
  assert.equal(options.environment.POMEGR_RELEASE_NODE_BOOTSTRAPPED, "1");
});

test("runtime bootstrap failures stop before validation and cannot recurse", async () => {
  const base = {
    nodeVersion: "v24.14.0", platform: "win32", arch: "x64", bootstrapped: false,
    readText: async () => WORKFLOW, report() {},
    validate: async () => assert.fail("failed bootstrap must not dispatch"),
  };
  await assert.rejects(runReleaseCli(["--tag", TAG], {
    ...base, ensureRuntime: async () => { throw new Error("download failed"); },
    runCommand: async () => assert.fail("failed download must not launch"),
  }), /download failed/);
  await assert.rejects(runReleaseCli(["--tag", TAG], {
    ...base, ensureRuntime: async () => "C:/cached/node.exe",
    runCommand: async () => ({ code: 1 }),
  }), /COMMAND_FAILED/);
  await assert.rejects(runReleaseCli(["--tag", TAG], {
    ...base, bootstrapped: true,
    ensureRuntime: async () => assert.fail("must not bootstrap recursively"),
  }), /NODE_VERSION_MISMATCH/);
});

test("matching Node validates directly without obtaining another runtime", async () => {
  let validated = false;
  await runReleaseCli(["--tag", TAG], {
    nodeVersion: "v22.13.0", platform: "win32", arch: "x64",
    readText: async () => WORKFLOW, report() {},
    ensureRuntime: async () => assert.fail("matching runtime must be reused"),
    validate: async ({ tag }) => { assert.equal(tag, TAG); validated = true; return { dispatched: true }; },
  });
  assert.equal(validated, true);
});

test("runtime cache verifies official checksums, reuses downloads, and repairs corruption", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-release-node-test-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const binary = Buffer.from("synthetic executable; never executed");
  const checksum = createHash("sha256").update(binary).digest("hex");
  const urls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    urls.push(url);
    return new Response(url.endsWith("SHASUMS256.txt") ? `${checksum}  win-x64/node.exe\n` : binary);
  };
  const options = { version: "22.13.0", repositoryRoot: root, fetchImpl };
  const executable = await ensureReleaseNodeRuntime(options);
  assert.deepEqual(await readFile(executable), binary);
  assert.deepEqual(urls, [
    "https://nodejs.org/dist/v22.13.0/SHASUMS256.txt",
    "https://nodejs.org/dist/v22.13.0/win-x64/node.exe",
  ]);
  assert.equal(await ensureReleaseNodeRuntime(options), executable);
  assert.equal(urls.length, 2, "valid cache must work offline");
  await writeFile(executable, "corrupted");
  await ensureReleaseNodeRuntime(options);
  assert.equal(urls.length, 4);
  assert.deepEqual(await readFile(executable), binary);
});

test("bad or oversized downloads never publish an executable", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-release-node-reject-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const options = { version: "22.13.0", repositoryRoot: root };
  for (const [manifest, pattern] of [
    ["no recognized checksum", /CHECKSUM_MISSING/],
    [`${"a".repeat(64)}  win-x64/node.exe\n`, /CHECKSUM_MISMATCH/],
    ["x".repeat(128 * 1024 + 1), /DOWNLOAD_TOO_LARGE/],
  ]) {
    await assert.rejects(ensureReleaseNodeRuntime({
      ...options, fetchImpl: async (url) => new Response(url.endsWith("SHASUMS256.txt") ? manifest : "bad binary"),
    }), pattern);
  }
  await assert.rejects(readFile(path.join(root, ".electron-builder-cache", "release-node", "22.13.0", "node.exe")), { code: "ENOENT" });
  await assert.rejects(ensureReleaseNodeRuntime({ ...options, version: "../escape" }), /VERSION_INVALID/);
  await assert.rejects(ensureReleaseNodeRuntime({ ...options, fetchImpl: async () => new Response(null, { status: 503 }) }), /DOWNLOAD_FAILED/);
});
