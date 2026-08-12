import { extractFile, listPackage } from "@electron/asar";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCEPTANCE_PRIOR_ARTIFACT,
  ACCEPTANCE_PRIOR_OUTPUT,
  ACCEPTANCE_PRIOR_VERSION,
} from "./acceptance-prior.mjs";
import {
  EXTERNAL_LEGAL_FILES,
  EXTERNAL_RUNTIME_FILES,
  assertNonemptyFile,
  assertPackagedApplicationFiles,
  dependencyNoticeKeys,
  isDependencyPackageManifest,
  normalizeArtifactPath,
  recursiveFiles,
} from "./artifact-policy.mjs";
import { SHARP_UNPACKED_FILES, WORKER_BUNDLE_FILES } from "./asar-policy.mjs";
import { TL_DT_05_PACKAGING_SCOPE } from "./tl-dt-05-scope.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, ACCEPTANCE_PRIOR_OUTPUT);
const unpackedRoot = path.join(outputRoot, "win-unpacked");
const resourcesRoot = path.join(unpackedRoot, "resources");
const archivePath = path.join(resourcesRoot, "app.asar");
const readArchiveFile = (filename) => extractFile(archivePath, filename.split("/").join(path.sep));

try {
  await assertNonemptyFile(path.join(outputRoot, ACCEPTANCE_PRIOR_ARTIFACT));
  await assertNonemptyFile(path.join(unpackedRoot, "Threadlight.exe"));
  await assertNonemptyFile(path.join(unpackedRoot, "LICENSE.electron.txt"));
  await assertNonemptyFile(path.join(unpackedRoot, "LICENSES.chromium.html"));
  await assertNonemptyFile(archivePath);
  for (const filename of EXTERNAL_RUNTIME_FILES) await assertNonemptyFile(path.join(resourcesRoot, filename));

  const applicationFiles = listPackage(archivePath).map(normalizeArtifactPath);
  const result = assertPackagedApplicationFiles(applicationFiles);
  const packagedMetadata = JSON.parse(readArchiveFile("package.json").toString("utf8"));
  if (packagedMetadata.version !== ACCEPTANCE_PRIOR_VERSION
    || packagedMetadata.threadlightPackagingScope !== TL_DT_05_PACKAGING_SCOPE) {
    throw new Error("DESKTOP_ACCEPTANCE_PRIOR_METADATA_INVALID");
  }

  const unpackedFiles = (await recursiveFiles(`${archivePath}.unpacked`)).map(normalizeArtifactPath);
  if (unpackedFiles.some((filename) => !applicationFiles.includes(filename))) {
    throw new Error("DESKTOP_ACCEPTANCE_UNPACKED_FILE_UNTRACKED");
  }
  const sharp = unpackedFiles.filter((filename) => filename.startsWith("node_modules/@img/sharp-win32-x64/lib/"));
  const workers = unpackedFiles.filter((filename) => filename.startsWith("desktop/workers/"));
  if (JSON.stringify(sharp) !== JSON.stringify([...SHARP_UNPACKED_FILES].sort())
    || JSON.stringify(workers) !== JSON.stringify([...WORKER_BUNDLE_FILES].sort())) {
    throw new Error("DESKTOP_ACCEPTANCE_UNPACK_BOUNDARY_INVALID");
  }

  const externalLegal = (await recursiveFiles(resourcesRoot))
    .map(normalizeArtifactPath)
    .filter((filename) => filename.startsWith("legal/"));
  if (JSON.stringify(externalLegal) !== JSON.stringify([...EXTERNAL_LEGAL_FILES].sort())) {
    throw new Error("DESKTOP_ACCEPTANCE_LEGAL_SET_INVALID");
  }

  const dependencyKeys = [];
  for (const manifestPath of applicationFiles.filter(isDependencyPackageManifest)) {
    const manifest = JSON.parse(readArchiveFile(manifestPath).toString("utf8"));
    dependencyKeys.push(`${manifest.name}@${manifest.version}`);
  }
  const projectPackage = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  dependencyKeys.push(`electron@${projectPackage.devDependencies.electron}`);
  const noticeKeys = dependencyNoticeKeys(await readFile(path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8"));
  if (JSON.stringify([...new Set(dependencyKeys)].sort()) !== JSON.stringify(noticeKeys)) {
    throw new Error("DESKTOP_ACCEPTANCE_DEPENDENCY_NOTICE_MISMATCH");
  }

  if ((await readdir(resourcesRoot)).some((name) => !["app.asar", "app.asar.unpacked", "legal", ...EXTERNAL_RUNTIME_FILES].includes(name))) {
    throw new Error("DESKTOP_ACCEPTANCE_RESOURCE_NOT_ALLOWLISTED");
  }
  if (JSON.stringify((await readdir(outputRoot)).sort())
    !== JSON.stringify([ACCEPTANCE_PRIOR_ARTIFACT, "win-unpacked"].sort())) {
    throw new Error("DESKTOP_ACCEPTANCE_OUTPUT_NOT_ALLOWLISTED");
  }
  console.log(`Threadlight test-only prior installer inspection: PASS (${result.fileCount} packaged files; ${unpackedFiles.length} unpacked files).`);
} catch (error) {
  const code = /^DESKTOP_[A-Z_]+$/.test(error?.message) ? error.message : "DESKTOP_ACCEPTANCE_INSPECTION_FAILED";
  console.error(`Threadlight test-only prior installer inspection: FAIL (${code})`);
  process.exitCode = 1;
}
