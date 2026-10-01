import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseReleaseVersion } from "../desktop/packaging/release-policy.mjs";
import { spawnCommand } from "./release-windows-local.mjs";

const USAGE = "Usage: npm run version:bump -- X.Y.Z";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function captured(runCommand, args, cwd) {
  const result = await runCommand("git", args, { cwd, capture: true });
  return (typeof result === "string" ? result : result?.stdout || "").trim();
}

// The version commit a release starts from: set the version, commit both package files, and push
// the checked-out branch. It reaches main the way that branch does; the release runs from main.
export async function bumpVersion({
  version,
  cwd = REPOSITORY_ROOT,
  runCommand = spawnCommand,
  npmCli = process.env.npm_execpath,
  nodeExecutable = process.execPath,
  report = () => {},
} = {}) {
  if (typeof version !== "string") throw new Error("POMEGR_VERSION_REQUIRED");
  const next = version.startsWith("v") ? version.slice(1) : version;
  parseReleaseVersion(next);
  if (!npmCli) throw new Error("POMEGR_VERSION_NPM_CLI_REQUIRED");

  if (await captured(runCommand, ["status", "--porcelain=v1", "--untracked-files=all"], cwd)) throw new Error("POMEGR_VERSION_CHECKOUT_DIRTY");
  const branch = await captured(runCommand, ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!branch || branch === "HEAD") throw new Error("POMEGR_VERSION_BRANCH_REQUIRED");

  report(`Setting version ${next} on ${branch}.`);
  await runCommand(nodeExecutable, [npmCli, "version", next, "--no-git-tag-version"], { cwd });
  await runCommand("git", ["add", "--", "package.json", "package-lock.json"], { cwd });
  await runCommand("git", ["commit", "-m", `chore: bump version to ${next}`], { cwd });
  await runCommand("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd });
  return { version: next, branch };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const report = (message) => process.stdout.write(`${message}\n`);
  if (argv.length !== 1 || argv[0] === "--help" || argv[0] === "-h") {
    report(USAGE);
    process.exitCode = argv.length === 1 ? 0 : 1;
  } else {
    bumpVersion({ version: argv[0], report }).then(({ version, branch }) => {
      report(`Version ${version} pushed to ${branch}. Once it is on main, release it with: npm run release:windows -- --tag v${version}`);
    }, (error) => {
      process.stderr.write(`${error.message}\n`);
      if (error.message === "POMEGR_VERSION_CHECKOUT_DIRTY") process.stderr.write("Commit or discard local changes before bumping the version.\n");
      if (error.message === "POMEGR_VERSION_BRANCH_REQUIRED") process.stderr.write("Check out a branch first; a detached HEAD has nowhere to push.\n");
      process.exitCode = 1;
    });
  }
}
