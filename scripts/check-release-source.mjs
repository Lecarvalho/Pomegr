import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertDirectoryHasNoPrivacySentinel, assertFileHasNoPrivacySentinel } from "../desktop/runtime/artifact-privacy.mjs";
import { assertReleaseTag } from "../desktop/packaging/release-policy.mjs";

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tarExecutable = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "tar";

function git(repositoryRoot, args, errorCode) {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(errorCode);
  }
}

function extract(archivePath, outputRoot) {
  try {
    execFileSync(tarExecutable, ["-xf", archivePath, "-C", outputRoot], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
  } catch {
    throw new Error("RELEASE_SOURCE_ARCHIVE_EXTRACTION_FAILED");
  }
}

export async function checkReleaseSource({
  repositoryRoot = defaultRepositoryRoot,
  tag,
  ref,
} = {}) {
  if (tag !== undefined && ref !== undefined) throw new Error("RELEASE_SOURCE_REFERENCE_INVALID");
  const sourceRef = tag !== undefined ? `refs/tags/${tag}` : (ref ?? "HEAD");
  const packageSource = git(repositoryRoot, ["show", `${sourceRef}:package.json`], "RELEASE_SOURCE_TAG_NOT_FOUND");
  let version;
  try { version = JSON.parse(packageSource).version; } catch { throw new Error("RELEASE_SOURCE_PACKAGE_INVALID"); }
  assertReleaseTag({ tag: tag ?? `v${version}`, version });

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pomegr-release-source-"));
  try {
    const archivePath = path.join(temporaryRoot, `pomegr-${version}-source.zip`);
    const extractedRoot = path.join(temporaryRoot, "source");
    git(repositoryRoot, ["archive", "--format=zip", `--prefix=pomegr-${version}/`, "--output", archivePath, sourceRef], "RELEASE_SOURCE_ARCHIVE_FAILED");
    // ZIP storage can leave test fixtures visible in raw bytes. Apply the
    // path-specific sentinel policy to extracted files, keeping the ZIP bound.
    await assertFileHasNoPrivacySentinel(archivePath, { allowSentinel: true });
    await mkdir(extractedRoot);
    extract(archivePath, extractedRoot);
    await assertDirectoryHasNoPrivacySentinel(extractedRoot, {
      allowedSentinelPath: (relativePath) => /^[^/]+\/tests\//.test(relativePath),
    });
    return Object.freeze({ tag, version, ref: sourceRef });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runCli() {
  const args = process.argv.slice(2);
  const tagIndex = args.indexOf("--tag");
  const refIndex = args.indexOf("--ref");
  const result = await checkReleaseSource({
    tag: tagIndex === -1 ? undefined : args[tagIndex + 1],
    ref: refIndex === -1 ? undefined : args[refIndex + 1],
  });
  process.stdout.write(`release source verified for ${result.tag ?? result.ref}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
