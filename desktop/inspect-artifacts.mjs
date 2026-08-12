import { extractFile, listPackage, statFile } from "@electron/asar";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTERNAL_LEGAL_FILES,
  EXTERNAL_RUNTIME_FILES,
  PUBLIC_LEGAL_FILES,
  assertNonemptyFile,
  assertPackagedApplicationFiles,
  dependencyNoticeKeys,
  expectedArtifactNames,
  expectedUpdateArtifactNames,
  isDependencyPackageManifest,
  normalizeArtifactPath,
  recursiveFiles,
} from "./artifact-policy.mjs";
import { SHARP_UNPACKED_FILES, WORKER_BUNDLE_FILES } from "./asar-policy.mjs";
import {
  assertBytesHaveNoPrivacySentinel,
  assertDirectoryHasNoPrivacySentinel,
  assertExtractedArtifactHasNoPrivacySentinel,
  inspectAsarPrivacyEntry,
  MAX_PRIVACY_SCAN_FILE_BYTES,
  MAX_PRIVACY_SCAN_FILES,
  MAX_PRIVACY_SCAN_TOTAL_BYTES,
  resolveArtifactExtractor,
} from "./artifact-privacy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const releaseRoot = path.join(repositoryRoot, packageJson.build.directories.output);
const unpackedRoot = path.join(releaseRoot, "win-unpacked");
const resourcesRoot = path.join(unpackedRoot, "resources");
const archivePath = path.join(resourcesRoot, "app.asar");
const readArchiveFile = (filename) => extractFile(archivePath, filename.split("/").join(path.sep));

try {
  const artifactSizes = [];
  for (const artifactName of expectedArtifactNames(packageJson.version)) {
    artifactSizes.push(await assertNonemptyFile(path.join(releaseRoot, artifactName)));
  }
  for (const artifactName of expectedUpdateArtifactNames(packageJson.version)) {
    artifactSizes.push(await assertNonemptyFile(path.join(releaseRoot, artifactName)));
  }
  await assertNonemptyFile(path.join(unpackedRoot, "Threadlight.exe"));
  await assertNonemptyFile(path.join(unpackedRoot, "LICENSE.electron.txt"));
  await assertNonemptyFile(path.join(unpackedRoot, "LICENSES.chromium.html"));
  await assertNonemptyFile(archivePath);
  await assertDirectoryHasNoPrivacySentinel(unpackedRoot);
  for (const filename of EXTERNAL_RUNTIME_FILES) await assertNonemptyFile(path.join(resourcesRoot, filename));
  const updateConfiguration = await readFile(path.join(resourcesRoot, "app-update.yml"), "utf8");
  for (const expected of ["provider: github", "owner: Lecarvalho", "repo: threadlight"]) {
    if (!updateConfiguration.includes(expected)) throw new Error("DESKTOP_UPDATE_CONFIGURATION_INVALID");
  }
  if (/(?:token|authorization|password|credential|private[-_ ]?key)\s*:/i.test(updateConfiguration)) {
    throw new Error("DESKTOP_UPDATE_CONFIGURATION_PRIVATE");
  }

  const applicationFiles = listPackage(archivePath).map(normalizeArtifactPath);
  const packageResult = assertPackagedApplicationFiles(applicationFiles);
  let asarFiles = 0;
  let asarBytes = 0;
  for (const filename of applicationFiles) {
    const archiveFilename = filename.split("/").join(path.sep);
    const details = inspectAsarPrivacyEntry(archivePath, archiveFilename, statFile);
    if (details.files) continue;
    asarFiles += 1;
    asarBytes += Number(details.size || 0);
    if (asarFiles > MAX_PRIVACY_SCAN_FILES
      || Number(details.size || 0) > MAX_PRIVACY_SCAN_FILE_BYTES
      || asarBytes > MAX_PRIVACY_SCAN_TOTAL_BYTES) {
      throw new Error("DESKTOP_ARTIFACT_PRIVACY_BOUND_EXCEEDED");
    }
    try { assertBytesHaveNoPrivacySentinel(readArchiveFile(filename)); } catch (error) {
      if (/^DESKTOP_ARTIFACT_PRIVACY_/.test(error?.message || "")) throw error;
      throw new Error("DESKTOP_ARTIFACT_ASAR_READ_FAILED");
    }
  }
  const extractorPath = await resolveArtifactExtractor();
  for (const artifactName of expectedArtifactNames(packageJson.version)) {
    await assertExtractedArtifactHasNoPrivacySentinel(path.join(releaseRoot, artifactName), extractorPath);
  }

  const unpackedFiles = (await recursiveFiles(`${archivePath}.unpacked`)).map(normalizeArtifactPath);
  for (const filename of unpackedFiles) {
    if (!applicationFiles.includes(filename)) throw new Error("DESKTOP_ARTIFACT_UNPACKED_FILE_UNTRACKED");
  }
  const sharpUnpacked = unpackedFiles.filter((filename) => filename.startsWith("node_modules/@img/sharp-win32-x64/lib/"));
  const workerUnpacked = unpackedFiles.filter((filename) => filename.startsWith("desktop/workers/"));
  if (JSON.stringify(sharpUnpacked) !== JSON.stringify([...SHARP_UNPACKED_FILES].sort())) {
    throw new Error("DESKTOP_ARTIFACT_SHARP_BOUNDARY_INVALID");
  }
  if (JSON.stringify(workerUnpacked) !== JSON.stringify([...WORKER_BUNDLE_FILES].sort())) {
    throw new Error("DESKTOP_ARTIFACT_WORKER_BOUNDARY_INVALID");
  }

  const externalLegalFiles = (await recursiveFiles(resourcesRoot))
    .map(normalizeArtifactPath)
    .filter((filename) => filename.startsWith("legal/"));
  if (JSON.stringify(externalLegalFiles) !== JSON.stringify([...EXTERNAL_LEGAL_FILES].sort())) {
    throw new Error("DESKTOP_ARTIFACT_LEGAL_SET_INVALID");
  }
  const legalMappings = [
    ["LICENSE", "legal/LICENSE", "dist/client/legal/LICENSE.txt"],
    ["NOTICE", "legal/NOTICE", "dist/client/legal/NOTICE.txt"],
    ["SOURCE.md", "legal/SOURCE.md", "dist/client/legal/SOURCE.txt"],
    ["THIRD_PARTY_NOTICES.md", "legal/THIRD_PARTY_NOTICES.md", "dist/client/legal/THIRD_PARTY_NOTICES.txt"],
    ["TRADEMARKS.md", "legal/TRADEMARKS.md", "dist/client/legal/TRADEMARKS.txt"],
  ];
  for (const [canonical, external, publicCopy] of legalMappings) {
    const [canonicalBytes, externalBytes, generatedPublicBytes] = await Promise.all([
      readFile(path.join(repositoryRoot, canonical)),
      readFile(path.join(resourcesRoot, ...external.split("/"))),
      readFile(path.join(repositoryRoot, "public", "legal", path.basename(publicCopy))),
    ]);
    const packagedPublicBytes = readArchiveFile(publicCopy);
    if (!canonicalBytes.length || !externalBytes.length || !generatedPublicBytes.length || !packagedPublicBytes.length) {
      throw new Error("DESKTOP_ARTIFACT_LEGAL_EMPTY");
    }
    if (!canonicalBytes.equals(externalBytes) || !generatedPublicBytes.equals(packagedPublicBytes)) {
      throw new Error("DESKTOP_ARTIFACT_LEGAL_CONTENT_MISMATCH");
    }
  }
  if (JSON.stringify(legalMappings.map(([, , filename]) => filename).sort()) !== JSON.stringify([...PUBLIC_LEGAL_FILES].sort())) {
    throw new Error("DESKTOP_ARTIFACT_PUBLIC_LEGAL_SET_INVALID");
  }

  const packagedDependencyKeys = [];
  for (const manifestPath of applicationFiles.filter(isDependencyPackageManifest)) {
    let manifest;
    try { manifest = JSON.parse(readArchiveFile(manifestPath).toString("utf8")); } catch {
      throw new Error("DESKTOP_ARTIFACT_DEPENDENCY_MANIFEST_INVALID");
    }
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error("DESKTOP_ARTIFACT_DEPENDENCY_MANIFEST_INVALID");
    }
    packagedDependencyKeys.push(`${manifest.name}@${manifest.version}`);
  }
  packagedDependencyKeys.push(`electron@${packageJson.devDependencies.electron}`);
  const noticeKeys = dependencyNoticeKeys(await readFile(path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8"));
  if (JSON.stringify([...new Set(packagedDependencyKeys)].sort()) !== JSON.stringify(noticeKeys)) {
    throw new Error("DESKTOP_ARTIFACT_DEPENDENCY_NOTICE_MISMATCH");
  }

  const unexpectedResources = (await readdir(resourcesRoot))
    .filter((name) => !["app.asar", "app.asar.unpacked", "app-update.yml", "legal", ...EXTERNAL_RUNTIME_FILES].includes(name));
  if (unexpectedResources.length) throw new Error("DESKTOP_ARTIFACT_RESOURCE_NOT_ALLOWLISTED");

  const expectedReleaseFiles = new Set(["win-unpacked", ...expectedArtifactNames(packageJson.version), ...expectedUpdateArtifactNames(packageJson.version)]);
  const releaseEntries = await readdir(releaseRoot);
  if (releaseEntries.includes("ThreadlightData")) {
    const portableData = await lstat(path.join(releaseRoot, "ThreadlightData"));
    if (!portableData.isDirectory() || portableData.isSymbolicLink()) throw new Error("DESKTOP_RELEASE_OUTPUT_NOT_ALLOWLISTED");
  }
  if (releaseEntries.some((filename) => filename !== "ThreadlightData" && !expectedReleaseFiles.has(filename))) {
    throw new Error("DESKTOP_RELEASE_OUTPUT_NOT_ALLOWLISTED");
  }

  console.log(`Threadlight desktop artifacts: PASS (${packageResult.fileCount} packaged files; ${unpackedFiles.length} unpacked runtime files; ${artifactSizes.length} Windows artifacts).`);
} catch (error) {
  const code = /^DESKTOP_[A-Z_]+$/.test(error?.message) ? error.message : "DESKTOP_ARTIFACT_INSPECTION_FAILED";
  console.error(`Threadlight desktop artifacts: FAIL (${code})`);
  process.exitCode = 1;
}
