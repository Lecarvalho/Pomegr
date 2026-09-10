import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseReleaseArguments,
  runReleaseCli,
  spawnCommand,
  validateThenDispatchRelease,
} from "../scripts/release-windows-local.mjs";
import {
  archiveExistingReleaseOutput,
  unsignedPackagingEnvironment,
  verifyWindowsReleaseLocally,
} from "../scripts/verify-windows-release-local.mjs";

const TAG = "v1.2.3";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function fixture({ fail, dirty = false, head = SHA, localTag = SHA, remoteTag = SHA, annotated = false, remoteMissing = false } = {}) {
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    const label = `${command} ${args.join(" ")}`;
    if (fail === label) throw new Error("fixture failure");
    if (command === "git" && args[0] === "status") return { stdout: dirty ? " M package.json\n" : "" };
    if (command === "git" && args[0] === "rev-parse") {
      return { stdout: `${args[1] === "HEAD" ? head : localTag}\n` };
    }
    if (command === "gh" && args[0] === "api" && args.at(-1).includes("/git/ref/tags/")) {
      if (remoteMissing) return { stdout: "{}" };
      return { stdout: JSON.stringify({ object: { type: annotated ? "tag" : "commit", sha: remoteTag } }) };
    }
    if (command === "gh" && args[0] === "api" && args.at(-1).includes("/git/tags/")) {
      return { stdout: JSON.stringify({ object: { type: "commit", sha: remoteTag } }) };
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
      readText: async () => JSON.stringify({ version: "1.2.3" }),
      runCommand: source.runCommand,
      ...options,
    }),
  };
}

function dispatches(calls) {
  return calls
    .filter(({ command, args }) => command === "gh" && args[0] === "workflow")
    .map(({ command, args }) => ({ command, args }));
}

test("release CLI arguments fail closed", () => {
  assert.deepEqual(parseReleaseArguments(["--tag", TAG, "--check-only"]), { tag: TAG, checkOnly: true, help: false });
  assert.deepEqual(parseReleaseArguments(["--help"]), { help: true });
  for (const args of [[], ["--tag"], ["--tag", TAG, "--tag", TAG], ["--unknown"]]) {
    assert.throws(() => parseReleaseArguments(args), /POMEGR_RELEASE_/);
  }
});

test("successful dispatch sends the exact clean tagged commit without local npm work", async () => {
  const reports = [];
  const { source, result } = runFixture({ report: (message) => reports.push(message) });
  assert.deepEqual(await result, { tag: TAG, version: "1.2.3", dispatched: true });
  assert.deepEqual(dispatches(source.calls), [{
    command: "gh",
    args: ["workflow", "run", "release.yml", "--repo", "https://github.com/Lecarvalho/Pomegr", "--ref", TAG, "-f", `tag=${TAG}`, "-f", `release_sha=${SHA}`],
  }]);
  assert.equal(source.calls.some(({ command }) => command === process.execPath || command === "powershell.exe"), false);
  assert.equal(reports.at(-1), `Release dispatch check passed for commit ${SHA}.`);
});

test("every failed dispatch gate blocks the workflow", async () => {
  for (const failure of [
    "gh auth status --hostname github.com",
    "gh api --hostname github.com --method GET repos/Lecarvalho/Pomegr",
    "git rev-parse HEAD",
    "git status --porcelain=v1 --untracked-files=all",
    `git rev-parse refs/tags/${TAG}^{commit}`,
  ]) {
    const { source, result } = runFixture({ fail: failure });
    await assert.rejects(result, /fixture failure/);
    assert.equal(dispatches(source.calls).length, 0, failure);
  }
});

test("tag, checkout, and remote mismatches fail before dispatch", async () => {
  await assert.rejects(validateThenDispatchRelease({
    tag: "v1.2.4",
    readText: async () => JSON.stringify({ version: "1.2.3" }),
    runCommand: async () => assert.fail("invalid version must fail before commands run"),
  }), /TAG_VERSION_MISMATCH/);
  for (const options of [
    { dirty: true },
    { localTag: OTHER_SHA },
    { remoteTag: OTHER_SHA },
    { remoteTag: OTHER_SHA, annotated: true },
    { remoteMissing: true },
  ]) {
    const { source, result } = runFixture(options);
    await assert.rejects(result, /POMEGR_RELEASE_(CHECKOUT_DIRTY|LOCAL_TAG_MISMATCH|REMOTE_TAG_MISMATCH|REMOTE_TAG_INVALID)/);
    assert.equal(dispatches(source.calls).length, 0);
  }
});

test("check-only validates the release point without dispatching", async () => {
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

test("release CLI delegates directly and preserves check-only", async () => {
  const reports = [];
  let received;
  await runReleaseCli(["--tag", TAG, "--check-only"], {
    report: (message) => reports.push(message),
    validate: async (options) => {
      received = options;
      return { dispatched: false };
    },
  });
  assert.equal(received.tag, TAG);
  assert.equal(received.checkOnly, true);
  assert.equal(received.report instanceof Function, true);
  assert.deepEqual(reports, ["Windows release dispatch check passed."]);
});

test("local release verification mirrors preventable CI stages without signing or publishing", async () => {
  const calls = [];
  const reports = [];
  const environment = {
    LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
    npm_execpath: "C:\\node\\npm-cli.js",
    CI: "true",
    GITHUB_ACTIONS: "true",
    GH_TOKEN: "private-token",
    GITHUB_TOKEN: "private-token",
    CSC_LINK: "private-certificate",
    ARTIFACT_SIGNING_ENDPOINT: "https://example.invalid",
    SAFE_VALUE: "preserved",
  };
  const result = await verifyWindowsReleaseLocally({
    platform: "win32",
    cwd: "C:\\pomegr",
    environment,
    nodeExecutable: "C:\\node\\node.exe",
    npmCli: environment.npm_execpath,
    archiveRelease: async () => "C:\\pomegr\\.electron-builder-cache\\local-package-backups\\fixture-release",
    report: (message) => reports.push(message),
    runCommand: async (command, args, options) => { calls.push({ command, args, options }); },
  });

  assert.deepEqual(result, { stageCount: 8, published: false, signed: false });
  assert.deepEqual(calls.map(({ args }) => args.slice(-2)), [
    ["run", "desktop:runtime"],
    ["run", "verify"],
    ["run", "desktop:smoke:ci"],
    ["run", "desktop:prepare:from-build"],
    ["--publish", "never"],
    ["C:\\pomegr\\desktop\\finalize-package.mjs"],
    ["run", "desktop:inspect"],
  ]);
  const packaging = calls[4];
  assert.match(packaging.args[0], /electron-builder[\\/]cli\.js$/);
  assert.equal(packaging.options.environment.SAFE_VALUE, "preserved");
  assert.equal(packaging.options.environment.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.equal(packaging.options.environment.ELECTRON_BUILDER_CACHE, "C:\\Users\\fixture\\AppData\\Local\\electron-builder\\Cache");
  for (const name of ["CI", "GITHUB_ACTIONS", "GH_TOKEN", "GITHUB_TOKEN", "CSC_LINK", "ARTIFACT_SIGNING_ENDPOINT"]) {
    assert.equal(Object.hasOwn(packaging.options.environment, name), false, name);
  }
  assert.equal(environment.GH_TOKEN, "private-token");
  assert.match(reports.at(-1), /unsigned and were not published/);
});

test("local release verification fails closed before unsupported or incomplete runs", async () => {
  await assert.rejects(verifyWindowsReleaseLocally({ platform: "linux" }), /POMEGR_LOCAL_RELEASE_WINDOWS_REQUIRED/);
  await assert.rejects(verifyWindowsReleaseLocally({
    platform: "win32",
    environment: { LOCALAPPDATA: "C:\\Temp" },
    npmCli: "",
  }), /POMEGR_LOCAL_RELEASE_NPM_CLI_REQUIRED/);
  assert.throws(() => unsignedPackagingEnvironment({ npm_execpath: "npm-cli.js" }), /POMEGR_LOCAL_RELEASE_LOCALAPPDATA_REQUIRED/);

  const calls = [];
  await assert.rejects(verifyWindowsReleaseLocally({
    platform: "win32",
    cwd: "C:\\pomegr",
    environment: { LOCALAPPDATA: "C:\\Temp", npm_execpath: "npm-cli.js" },
    archiveRelease: async () => null,
    runCommand: async (_command, _args, options) => {
      calls.push(options);
      if (calls.length === 2) throw new Error("fixture failure");
    },
    report: () => {},
  }), /POMEGR_LOCAL_RELEASE_VERIFICATION_FAILED \(Run the canonical verifier\)/);
  assert.equal(calls.length, 2);
});

test("local release verification archives existing generated output instead of deleting it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pomegr-local-release-"));
  const releaseRoot = path.join(root, "release");
  try {
    await mkdir(releaseRoot);
    await writeFile(path.join(releaseRoot, "previous-artifact.exe"), "fixture", "utf8");
    const backupPath = await archiveExistingReleaseOutput({ cwd: root });
    assert.match(backupPath, /\.electron-builder-cache[\\/]local-package-backups[\\/].+-release$/);
    assert.equal(await readFile(path.join(backupPath, "previous-artifact.exe"), "utf8"), "fixture");
    assert.deepEqual(await readdir(path.dirname(backupPath)), [path.basename(backupPath)]);
    assert.equal(await archiveExistingReleaseOutput({ cwd: root }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
