import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PRIVACY_SENTINEL = /[A-Z][A-Z0-9_]{2,80}_MUST_NOT_LEAK/;
export const MAX_PRIVACY_SCAN_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_PRIVACY_SCAN_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_PRIVACY_SCAN_FILES = 25_000;

export async function assertFileHasNoPrivacySentinel(filename, options = {}) {
  const details = await stat(filename).catch(() => { throw new Error("DESKTOP_ARTIFACT_PRIVACY_READ_FAILED"); });
  const maximumBytes = options.maximumBytes ?? MAX_PRIVACY_SCAN_FILE_BYTES;
  if (!details.isFile() || details.size > maximumBytes) throw new Error("DESKTOP_ARTIFACT_PRIVACY_BOUND_EXCEEDED");
  let tail = "";
  let readBytes = 0;
  try {
    for await (const chunk of createReadStream(filename)) {
      readBytes += chunk.length;
      if (readBytes > maximumBytes) throw new Error("DESKTOP_ARTIFACT_PRIVACY_BOUND_EXCEEDED");
      const text = tail + chunk.toString("utf8");
      if (PRIVACY_SENTINEL.test(text) && options.allowSentinel !== true) {
        throw new Error("DESKTOP_ARTIFACT_PRIVACY_SENTINEL");
      }
      tail = text.slice(-128);
    }
  } catch (error) {
    if (/^DESKTOP_ARTIFACT_PRIVACY_/.test(error?.message || "")) throw error;
    throw new Error("DESKTOP_ARTIFACT_PRIVACY_READ_FAILED");
  }
  return readBytes;
}

export async function assertDirectoryHasNoPrivacySentinel(root, options = {}) {
  const state = options.state || { bytes: 0, files: 0 };
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch {
    throw new Error("DESKTOP_ARTIFACT_PRIVACY_READ_FAILED");
  }
  for (const entry of entries) {
    const filename = path.join(root, entry.name);
    const relativePath = path.relative(options.scanRoot || root, filename).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) throw new Error("DESKTOP_ARTIFACT_PRIVACY_LINK_FORBIDDEN");
    if (entry.isDirectory()) {
      await assertDirectoryHasNoPrivacySentinel(filename, { ...options, scanRoot: options.scanRoot || root, state });
    } else if (entry.isFile()) {
      state.files += 1;
      if (state.files > (options.maximumFiles ?? MAX_PRIVACY_SCAN_FILES)) throw new Error("DESKTOP_ARTIFACT_PRIVACY_BOUND_EXCEEDED");
      state.bytes += await assertFileHasNoPrivacySentinel(filename, {
        maximumBytes: options.maximumFileBytes,
        allowSentinel: options.allowedSentinelPath?.(relativePath) === true,
      });
      if (state.bytes > (options.maximumTotalBytes ?? MAX_PRIVACY_SCAN_TOTAL_BYTES)) {
        throw new Error("DESKTOP_ARTIFACT_PRIVACY_BOUND_EXCEEDED");
      }
    } else {
      throw new Error("DESKTOP_ARTIFACT_PRIVACY_FILE_TYPE_FORBIDDEN");
    }
  }
}

export function assertBytesHaveNoPrivacySentinel(bytes) {
  if (PRIVACY_SENTINEL.test(Buffer.from(bytes).toString("utf8"))) {
    throw new Error("DESKTOP_ARTIFACT_PRIVACY_SENTINEL");
  }
}

export function inspectAsarPrivacyEntry(archivePath, filename, statAsarFile) {
  let details;
  try { details = statAsarFile(archivePath, filename, false); } catch {
    throw new Error("DESKTOP_ARTIFACT_ASAR_READ_FAILED");
  }
  if (details?.link) throw new Error("DESKTOP_ARTIFACT_PRIVACY_LINK_FORBIDDEN");
  if (!details || typeof details !== "object") throw new Error("DESKTOP_ARTIFACT_ASAR_READ_FAILED");
  return details;
}

export async function resolveArtifactExtractor(environment = process.env) {
  const cacheRoot = path.join(environment.LOCALAPPDATA || "", "electron-builder", "Cache");
  let entries;
  try { entries = await readdir(cacheRoot, { recursive: true }); } catch {
    throw new Error("DESKTOP_ARTIFACT_EXTRACTOR_MISSING");
  }
  const relative = entries.find((entry) => /(?:^|[\\/])bin[\\/]7za\.exe$/i.test(entry));
  if (!relative) throw new Error("DESKTOP_ARTIFACT_EXTRACTOR_MISSING");
  return path.join(cacheRoot, relative);
}

function runExtractor(extractorPath, archivePath, outputRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(extractorPath, ["x", "-y", `-o${outputRoot}`, archivePath], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    child.once("error", () => reject(new Error("DESKTOP_ARTIFACT_EXTRACTION_FAILED")));
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error("DESKTOP_ARTIFACT_EXTRACTION_FAILED")));
  });
}

export async function assertExtractedArtifactHasNoPrivacySentinel(archivePath, extractorPath, options = {}) {
  if (!(await stat(extractorPath)).isFile()) throw new Error("DESKTOP_ARTIFACT_EXTRACTOR_MISSING");
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-artifact-privacy-"));
  try {
    await runExtractor(extractorPath, archivePath, root);
    await assertDirectoryHasNoPrivacySentinel(root, options);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function assertReleasePublishPrivacy(outputRoot, expectedNames, options = {}) {
  const actual = (await readdir(outputRoot)).sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("DESKTOP_RELEASE_ARTIFACT_SET_INVALID");
  for (const name of actual) {
    const filename = path.join(outputRoot, name);
    await assertFileHasNoPrivacySentinel(filename);
    if (/^Threadlight-(?:Setup|Portable)-.+\.exe$/i.test(name) && options.extractorPath !== false) {
      const extractorPath = options.extractorPath || await resolveArtifactExtractor(options.environment);
      await assertExtractedArtifactHasNoPrivacySentinel(filename, extractorPath);
    }
    if (/^Threadlight-.+-source\.zip$/i.test(name) && options.extractorPath !== false) {
      const extractorPath = options.extractorPath || await resolveArtifactExtractor(options.environment);
      await assertExtractedArtifactHasNoPrivacySentinel(filename, extractorPath, {
        allowedSentinelPath: (relativePath) => /^[^/]+\/tests\//.test(relativePath),
      });
    }
  }
}
