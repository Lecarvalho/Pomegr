import assert from "node:assert/strict";
import test from "node:test";

import {
  parseReleaseArguments,
  runReleaseCli,
  spawnCommand,
  validateThenDispatchRelease,
} from "../scripts/release-windows-local.mjs";

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
