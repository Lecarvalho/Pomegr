import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_LEGAL_FILES,
  assertReleaseTag,
  assertUpdateMetadata,
  releaseArtifactNames,
  renderChecksumManifest,
  updateMetadataName,
} from "./release-policy.mjs";
import { assertReleasePublishPrivacy } from "./artifact-privacy.mjs";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(moduleRoot, "..");

function git(repositoryRoot, args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function assertCleanTaggedCheckout(repositoryRoot, tag) {
  if (git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("DESKTOP_RELEASE_CHECKOUT_DIRTY");
  }
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const taggedCommit = git(repositoryRoot, ["rev-list", "-n", "1", tag]);
  if (!head || head !== taggedCommit) throw new Error("DESKTOP_RELEASE_TAG_NOT_AT_HEAD");
  return head;
}

async function sha256(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function assertRegularNonemptyFile(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error("DESKTOP_RELEASE_FILE_INVALID");
}

export async function prepareRelease({
  repositoryRoot = defaultRepositoryRoot,
  inputRoot = path.join(repositoryRoot, "release"),
  outputRoot = path.join(inputRoot, "publish"),
  tag,
  artifactExtractorPath,
} = {}) {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const { version } = packageJson;
  assertReleaseTag({ tag, version });
  assertCleanTaggedCheckout(repositoryRoot, tag);

  const installer = `Threadlight-Setup-${version}-x64.exe`;
  const requiredBuildFiles = [
    installer,
    `${installer}.blockmap`,
    `Threadlight-Portable-${version}-x64.exe`,
    updateMetadataName(version),
    "RELEASE_NOTES.md",
  ];
  for (const name of requiredBuildFiles) await assertRegularNonemptyFile(path.join(inputRoot, name));
  await assertUpdateMetadata(await readFile(path.join(inputRoot, updateMetadataName(version)), "utf8"), version);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  for (const name of requiredBuildFiles) await copyFile(path.join(inputRoot, name), path.join(outputRoot, name));
  for (const name of RELEASE_LEGAL_FILES) {
    await assertRegularNonemptyFile(path.join(repositoryRoot, name));
    await copyFile(path.join(repositoryRoot, name), path.join(outputRoot, name));
  }

  const sourceName = `Threadlight-${version}-source.zip`;
  execFileSync("git", ["archive", "--format=zip", `--prefix=threadlight-${version}/`, "--output", path.join(outputRoot, sourceName), tag], {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });
  await assertRegularNonemptyFile(path.join(outputRoot, sourceName));

  const withoutChecksums = releaseArtifactNames(version, { includeChecksums: false });
  const entries = await Promise.all(withoutChecksums.map(async (name) => ({
    name,
    sha256: await sha256(path.join(outputRoot, name)),
  })));
  await writeFile(path.join(outputRoot, "SHA256SUMS.txt"), renderChecksumManifest(entries), { encoding: "utf8", flag: "wx" });

  const actual = await readdir(outputRoot);
  const expected = releaseArtifactNames(version);
  if (actual.length !== expected.length || expected.some((name) => !actual.includes(name))) {
    throw new Error("DESKTOP_RELEASE_OUTPUT_INVALID");
  }
  await assertReleasePublishPrivacy(outputRoot, expected, { extractorPath: artifactExtractorPath });
  return Object.freeze({ version, artifactCount: actual.length });
}

async function runCli() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const result = await prepareRelease({
    repositoryRoot: path.resolve(option("--repository-root", defaultRepositoryRoot)),
    inputRoot: path.resolve(option("--input", path.join(defaultRepositoryRoot, "release"))),
    outputRoot: path.resolve(option("--output", path.join(defaultRepositoryRoot, "release", "publish"))),
    tag: option("--tag"),
  });
  process.stdout.write(`prepared ${result.artifactCount} files for v${result.version}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
