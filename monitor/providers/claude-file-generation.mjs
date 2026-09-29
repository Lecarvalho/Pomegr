import crypto from "node:crypto";
import fs from "node:fs";

/** Bytes sampled from a transcript tail to prove that earlier content still matches. */
export const FILE_SUFFIX_SAMPLE_BYTES = 256;

/**
 * Append-only transcript files are cached by generation: a stable file identity plus a digest of
 * the recorded tail. Both must still match before a cached parse may be continued instead of redone.
 */
export function fileIdentity(stat) {
  const device = Number.isFinite(stat?.dev) ? stat.dev : null;
  const inode = Number.isFinite(stat?.ino) && stat.ino > 0 ? stat.ino : null;
  return inode !== null
    ? `${device ?? "device"}:${inode}`
    : `birth:${Number.isFinite(stat?.birthtimeMs) ? stat.birthtimeMs : "unknown"}`;
}
/**
 * Shared primitive behind `readFileSuffix` (size >= 1) and the file-generation reuse cache's
 * descriptor path (size >= 0, e.g. a just-created empty file): opens the file once and reads up
 * to `suffixBytes` trailing bytes, returning both the requested byte count and how many were
 * actually read so callers can apply their own "was this a complete read" rule without re-reading.
 */
export function readFileSuffixRaw(file, size, suffixBytes) {
  if (!Number.isInteger(size) || size < 0 || !Number.isInteger(suffixBytes) || suffixBytes < 1) return null;
  const bytes = Math.min(size, suffixBytes);
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(descriptor, buffer, 0, bytes, size - bytes);
    return { bytes, read, digest: crypto.createHash("sha256").update(buffer).digest("hex") };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
export function readFileSuffix(file, size, suffixBytes) {
  if (!Number.isInteger(size) || size < 1 || !Number.isInteger(suffixBytes) || suffixBytes < 1) return null;
  const raw = readFileSuffixRaw(file, size, suffixBytes);
  return raw && raw.read === raw.bytes ? { bytes: raw.bytes, digest: raw.digest } : null;
}
export function priorFileSuffixStillMatches(file, generation) {
  if (!generation?.suffixDigest || !Number.isInteger(generation.size) || generation.size < 1) return false;
  const suffix = readFileSuffix(file, generation.size, generation.suffixBytes);
  return suffix?.bytes === generation.suffixBytes && suffix.digest === generation.suffixDigest;
}
export function fileGeneration(file, stat) {
  const suffix = readFileSuffix(file, stat.size, FILE_SUFFIX_SAMPLE_BYTES);
  return suffix ? {
    identity: fileIdentity(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    suffixBytes: suffix.bytes,
    suffixDigest: suffix.digest,
  } : null;
}
/** `identity|size|mtimeMs|suffixDigest`: the exact-match key for per-file derived reuse. */
export function generationKey(generation) {
  return generation ? `${generation.identity}|${generation.size}|${generation.mtimeMs}|${generation.suffixDigest}` : null;
}
