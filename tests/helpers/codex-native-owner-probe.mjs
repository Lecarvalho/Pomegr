import path from "node:path";
import { readCodexWriterLock, queryCodexWriterOwners } from "../../monitor/providers/codex-writer-presence.mjs";

// Acceptance-only facade over the production read-only acquisition primitives.
// Return bounded proof fields; no native paths, PIDs or start identities.
export async function probeNativeWriterOwner(file, executable) {
  if (process.platform !== "win32" || !path.isAbsolute(file) || !path.isAbsolute(executable)) {
    return { state: "unavailable", nativeOwner: false };
  }
  file = path.resolve(file);
  executable = path.resolve(executable);
  const before = readCodexWriterLock(file);
  if (before.state !== "held") return { state: before.state, nativeOwner: false };
  const owners = await queryCodexWriterOwners([file], [executable]);
  const after = readCodexWriterLock(file);
  const stable = before.identity === after.identity && after.state === "held";
  return {
    state: stable ? "held" : "changed",
    nativeOwner: stable && owners.length === 1 && owners[0].index === 0,
  };
}
