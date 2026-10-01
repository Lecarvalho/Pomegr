import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertReleaseTag, parseReleaseVersion } from "../desktop/packaging/release-policy.mjs";

const REPOSITORY = "Lecarvalho/Pomegr";
const REPOSITORY_URL = "https://github.com/Lecarvalho/Pomegr";
const WORKFLOW = "release.yml";
const MAIN_BRANCH = "main";
const USAGE = "Usage: npm run release:windows -- --tag vX.Y.Z [--check-only]";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURE_LIMIT = 1024 * 1024;
const STDERR_LIMIT = 2048;

export function parseReleaseArguments(argv) {
  let tag;
  let checkOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--check-only") {
      if (checkOnly) throw new Error("POMEGR_RELEASE_ARGUMENTS_INVALID");
      checkOnly = true;
      continue;
    }
    if (argument === "--tag" && tag === undefined && argv[index + 1]) {
      tag = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("POMEGR_RELEASE_ARGUMENTS_INVALID");
  }
  if (!tag) throw new Error("POMEGR_RELEASE_TAG_REQUIRED");
  return { tag, checkOnly, help: false };
}

function capturedText(current, chunk, limit) {
  return current.length >= limit ? current : `${current}${chunk}`.slice(0, limit);
}

function stderrTail(value) {
  return value.length > STDERR_LIMIT ? value.slice(-STDERR_LIMIT) : value;
}

function commandFailure(command, args, stderr = "") {
  const diagnostic = stderrTail(stderr).trim();
  return new Error(`POMEGR_RELEASE_COMMAND_FAILED (${command} ${args.join(" ")})${diagnostic ? `\n${diagnostic}` : ""}`);
}

export async function spawnCommand(command, args, {
  cwd = REPOSITORY_ROOT, capture = false, stdin = "ignore",
  environment = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: capture ? [stdin, "pipe", "pipe"] : [stdin, "inherit", "inherit"],
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout = capturedText(stdout, chunk, CAPTURE_LIMIT); });
      child.stderr.on("data", (chunk) => { stderr = stderrTail(`${stderr}${chunk}`); });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(commandFailure(command, args, stderr));
    });
  });
}

async function execute(runCommand, command, args, cwd, options = {}) {
  const result = await runCommand(command, args, { cwd, ...options });
  if (typeof result === "string") return result;
  if (!result || (Object.hasOwn(result, "code") && result.code !== 0)) {
    throw commandFailure(command, args, result?.stderr || "");
  }
  return result.stdout || "";
}

function parseJson(value, errorCode) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(errorCode);
  }
}

function requireCommitSha(value, errorCode) {
  const sha = String(value || "");
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(errorCode);
  return sha.toLowerCase();
}

async function resolveRemoteTagCommit(runCommand, tag, cwd) {
  const reference = parseJson(await execute(runCommand, "gh", [
    "api", "--hostname", "github.com", "--method", "GET", `repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
  ], cwd, { capture: true }), "POMEGR_RELEASE_REMOTE_TAG_INVALID");
  const object = reference?.object;
  if (object?.type === "commit") return requireCommitSha(object.sha, "POMEGR_RELEASE_REMOTE_TAG_INVALID");
  if (object?.type !== "tag") throw new Error("POMEGR_RELEASE_REMOTE_TAG_INVALID");
  const tagObject = parseJson(await execute(runCommand, "gh", [
    "api", "--hostname", "github.com", "--method", "GET", `repos/${REPOSITORY}/git/tags/${requireCommitSha(object.sha, "POMEGR_RELEASE_REMOTE_TAG_INVALID")}`,
  ], cwd, { capture: true }), "POMEGR_RELEASE_REMOTE_TAG_INVALID");
  if (tagObject?.object?.type !== "commit") throw new Error("POMEGR_RELEASE_REMOTE_TAG_INVALID");
  return requireCommitSha(tagObject.object.sha, "POMEGR_RELEASE_REMOTE_TAG_INVALID");
}

async function assertClean(runCommand, cwd) {
  const status = await execute(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd, { capture: true });
  if (status.trim()) throw new Error("POMEGR_RELEASE_CHECKOUT_DIRTY");
}

async function localRevision(runCommand, reference, cwd) {
  return requireCommitSha((await execute(runCommand, "git", ["rev-parse", reference], cwd, { capture: true })).trim(), "POMEGR_RELEASE_LOCAL_TAG_INVALID");
}

async function resolveReleasePoint(runCommand, tag, cwd) {
  await assertClean(runCommand, cwd);
  const [head, localTag, remoteTag] = await Promise.all([
    localRevision(runCommand, "HEAD", cwd),
    localRevision(runCommand, `refs/tags/${tag}^{commit}`, cwd),
    resolveRemoteTagCommit(runCommand, tag, cwd),
  ]);
  if (localTag !== head) throw new Error("POMEGR_RELEASE_LOCAL_TAG_MISMATCH");
  if (remoteTag !== head) throw new Error("POMEGR_RELEASE_REMOTE_TAG_MISMATCH");
  return head;
}

async function readPackageVersion(readText, cwd) {
  const packageSource = await readText(path.join(cwd, "package.json"));
  return parseJson(packageSource, "POMEGR_RELEASE_PACKAGE_INVALID")?.version;
}

async function capturedLine(runCommand, args, cwd) {
  return (await execute(runCommand, "git", args, cwd, { capture: true })).trim();
}

// Creates the release point for a tag GitHub does not have yet: the annotated tag on the
// already-pushed version commit, and its push. The version itself is bumped and pushed by
// hand beforehand; this never edits package.json. An existing remote tag is never touched.
async function prepareReleasePoint({ runCommand, readText, tag, cwd, report }) {
  if (typeof tag !== "string" || !tag.startsWith("v")) throw new Error("DESKTOP_RELEASE_TAG_VERSION_MISMATCH");
  const version = tag.slice(1);
  parseReleaseVersion(version);
  await assertClean(runCommand, cwd);
  const tagReference = `refs/tags/${tag}`;
  if (await capturedLine(runCommand, ["ls-remote", "--tags", "origin", tagReference], cwd)) return;

  if (await capturedLine(runCommand, ["rev-parse", "--abbrev-ref", "HEAD"], cwd) !== MAIN_BRANCH) {
    throw new Error("POMEGR_RELEASE_BRANCH_NOT_MAIN");
  }
  await execute(runCommand, "git", ["fetch", "origin", MAIN_BRANCH], cwd, { capture: true });
  const remoteMain = await localRevision(runCommand, `refs/remotes/origin/${MAIN_BRANCH}`, cwd);
  if (await localRevision(runCommand, "HEAD", cwd) !== remoteMain) throw new Error("POMEGR_RELEASE_MAIN_NOT_SYNCED");

  if (await readPackageVersion(readText, cwd) !== version) throw new Error("POMEGR_RELEASE_VERSION_NOT_BUMPED");

  const localTagExists = Boolean(await capturedLine(runCommand, ["tag", "--list", tag], cwd));
  if (!localTagExists) {
    await execute(runCommand, "git", ["tag", "-a", tag, "-m", `Pomegr ${version}`], cwd);
  } else if (await localRevision(runCommand, `${tagReference}^{commit}`, cwd) !== await localRevision(runCommand, "HEAD", cwd)) {
    throw new Error("POMEGR_RELEASE_LOCAL_TAG_MISMATCH");
  }
  report(`Pushing tag ${tag}.`);
  await execute(runCommand, "git", ["push", "origin", tagReference], cwd);
}

export async function validateThenDispatchRelease({
  tag,
  checkOnly = false,
  cwd = REPOSITORY_ROOT,
  readText = (filename) => readFile(filename, "utf8"),
  runCommand = spawnCommand,
  report = () => {},
} = {}) {
  await execute(runCommand, "gh", ["auth", "status", "--hostname", "github.com"], cwd, { capture: true });
  await execute(runCommand, "gh", ["api", "--hostname", "github.com", "--method", "GET", `repos/${REPOSITORY}`], cwd, { capture: true });
  if (!checkOnly) await prepareReleasePoint({ runCommand, readText, tag, cwd, report });

  const packageVersion = await readPackageVersion(readText, cwd);
  assertReleaseTag({ tag, version: packageVersion });
  const head = await resolveReleasePoint(runCommand, tag, cwd);
  if (!checkOnly) {
    await execute(runCommand, "gh", [
      "workflow", "run", WORKFLOW, "--repo", REPOSITORY_URL, "--ref", tag, "-f", `tag=${tag}`, "-f", `release_sha=${head}`,
    ], cwd, { stdin: "ignore" });
  }
  report(`Release dispatch check passed for commit ${head}.`);
  return { tag, version: packageVersion, dispatched: !checkOnly };
}

export async function runReleaseCli(argv, {
  validate = validateThenDispatchRelease,
  report = (message) => process.stdout.write(`${message}\n`),
} = {}) {
  const options = parseReleaseArguments(argv);
  if (options.help) {
    report(USAGE);
    return;
  }
  const result = await validate({ ...options, report });
  report(result.dispatched ? "Windows release workflow dispatched." : "Windows release dispatch check passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runReleaseCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    if (error.message === "POMEGR_RELEASE_CHECKOUT_DIRTY") {
      process.stderr.write("Commit or discard local changes before releasing.\n");
    }
    if (error.message === "POMEGR_RELEASE_BRANCH_NOT_MAIN" || error.message === "POMEGR_RELEASE_MAIN_NOT_SYNCED") {
      process.stderr.write("A new release starts from main at the same commit as origin/main.\n");
    }
    if (error.message === "POMEGR_RELEASE_VERSION_NOT_BUMPED") {
      process.stderr.write("package.json does not have the tag's version. Run `npm run version:bump -- X.Y.Z`, get it onto main, then rerun.\n");
    }
    process.exitCode = 1;
  });
}
