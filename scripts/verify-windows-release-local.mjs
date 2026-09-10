import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { spawnCommand } from "./release-windows-local.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RELEASE_ONLY_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_EVENT_NAME",
  "GITHUB_REF",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID",
  "GITHUB_SHA",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "ARTIFACT_SIGNING_ENDPOINT",
  "ARTIFACT_SIGNING_ACCOUNT_NAME",
  "ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME",
  "WINDOWS_PUBLISHER_SUBJECT",
]);

export function unsignedPackagingEnvironment(environment = process.env) {
  if (!environment.LOCALAPPDATA) throw new Error("POMEGR_LOCAL_RELEASE_LOCALAPPDATA_REQUIRED");
  const safe = { ...environment };
  for (const name of RELEASE_ONLY_ENVIRONMENT_KEYS) delete safe[name];
  safe.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  safe.ELECTRON_BUILDER_CACHE = path.join(environment.LOCALAPPDATA, "electron-builder", "Cache");
  return safe;
}

export async function archiveExistingReleaseOutput({ cwd = REPOSITORY_ROOT } = {}) {
  const repositoryRoot = path.resolve(cwd);
  const releaseRoot = path.resolve(repositoryRoot, "release");
  if (!releaseRoot.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("POMEGR_LOCAL_RELEASE_ROOT_INVALID");

  let details;
  try { details = await lstat(releaseRoot); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("POMEGR_LOCAL_RELEASE_OUTPUT_INSPECTION_FAILED");
  }
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("POMEGR_LOCAL_RELEASE_OUTPUT_INVALID");
  if ((await readdir(releaseRoot)).length === 0) return null;

  const backupRoot = path.join(repositoryRoot, ".electron-builder-cache", "local-package-backups");
  await mkdir(backupRoot, { recursive: true });
  const backupDetails = await lstat(backupRoot);
  if (backupDetails.isSymbolicLink() || !backupDetails.isDirectory()) {
    throw new Error("POMEGR_LOCAL_RELEASE_BACKUP_ROOT_INVALID");
  }
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  const backupPath = path.join(backupRoot, `${timestamp}-${randomUUID().slice(0, 8)}-release`);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rename(releaseRoot, backupPath);
      return backupPath;
    } catch (error) {
      if (attempt === 5 || !["EACCES", "EBUSY", "EPERM"].includes(error?.code)) {
        throw new Error("POMEGR_LOCAL_RELEASE_OUTPUT_ARCHIVE_FAILED");
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw new Error("POMEGR_LOCAL_RELEASE_OUTPUT_ARCHIVE_FAILED");
}

async function runStep(runCommand, step, total, report) {
  report(`[${step.number}/${total}] ${step.label}`);
  try {
    await runCommand(step.command, step.args, {
      cwd: step.cwd,
      environment: step.environment,
    });
  } catch (error) {
    throw new Error(`POMEGR_LOCAL_RELEASE_VERIFICATION_FAILED (${step.label})\n${error?.message || "Unknown command failure"}`);
  }
}

export async function verifyWindowsReleaseLocally({
  platform = process.platform,
  cwd = REPOSITORY_ROOT,
  environment = process.env,
  nodeExecutable = process.execPath,
  npmCli = environment.npm_execpath,
  runCommand = spawnCommand,
  archiveRelease = archiveExistingReleaseOutput,
  report = (message) => process.stdout.write(`${message}\n`),
} = {}) {
  if (platform !== "win32") throw new Error("POMEGR_LOCAL_RELEASE_WINDOWS_REQUIRED");
  if (!npmCli) throw new Error("POMEGR_LOCAL_RELEASE_NPM_CLI_REQUIRED");

  const packagingEnvironment = unsignedPackagingEnvironment(environment);
  const npmRun = (script) => [nodeExecutable, [npmCli, "run", script]];
  const commandSteps = [
    ["Install the Electron runtime", ...npmRun("desktop:runtime"), environment],
    ["Run the canonical verifier", ...npmRun("verify"), environment],
    ["Smoke-test the packaged renderer", ...npmRun("desktop:smoke:ci"), environment],
    ["Prepare desktop files from the verified build", ...npmRun("desktop:prepare:from-build"), environment],
    ["Build unsigned Windows artifacts without publishing", nodeExecutable, [
      path.join(cwd, "node_modules", "electron-builder", "cli.js"),
      "--win", "nsis", "portable", "--x64", "--publish", "never",
    ], packagingEnvironment],
    ["Finalize desktop artifacts", nodeExecutable, [path.join(cwd, "desktop", "finalize-package.mjs")], environment],
    ["Inspect desktop artifacts", ...npmRun("desktop:inspect"), environment],
  ];
  const total = commandSteps.length + 1;
  const steps = commandSteps.map(([label, command, args, stepEnvironment], index) => ({
    number: index < 4 ? index + 1 : index + 2,
    label,
    command,
    args,
    cwd,
    environment: stepEnvironment,
  }));

  for (const step of steps.slice(0, 4)) await runStep(runCommand, step, total, report);
  report(`[5/${total}] Archive previous local release output`);
  const backupPath = await archiveRelease({ cwd });
  if (backupPath) report(`Previous local release output archived at ${backupPath}.`);
  for (const step of steps.slice(4)) await runStep(runCommand, step, total, report);
  report("Local Windows release verification passed. Artifacts are unsigned and were not published.");
  return { stageCount: total, published: false, signed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyWindowsReleaseLocally().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
