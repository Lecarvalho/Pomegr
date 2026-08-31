import fs from "node:fs";
import { createHash } from "node:crypto";

/** Verify bounded append continuity before carrying normalized evidence forward. */
export function priorSourceSuffixMatches(file, generation) {
  if (!generation?.suffixDigest || !Number.isInteger(generation.suffixBytes) || generation.suffixBytes < 1) return false;
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(generation.suffixBytes);
    const read = fs.readSync(descriptor, buffer, 0, generation.suffixBytes, generation.size - generation.suffixBytes);
    return read === generation.suffixBytes && createHash("sha256").update(buffer).digest("hex") === generation.suffixDigest;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
