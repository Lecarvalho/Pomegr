import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { normalizeUsageGuardConfig } from "../shared/usage-guard-policy.mjs";

const MAX_CONFIG_BYTES = 4096;
const MAX_STATES = 256;
const STATE_TTL_MS = 30 * 24 * 60 * 60_000;
const STATE_NAME = /^[a-f0-9]{64}\.json$/;
const COORDINATION_NAME = /^[a-f0-9]{64}\.json(?:\.lock|\.[a-f0-9]{16}\.tmp)$/;
const STAGES = new Set(["normal", "unknown", "warn", "handoff", "stop", "model_warning"]);

export function guardHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function regularFile(file, maxBytes) {
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maxBytes;
}

/** Nearest repository configuration, never a provider settings or transcript read. */
export function readUsageGuardConfig(cwd) {
  if (typeof cwd !== "string" || cwd.length > 4096 || !path.isAbsolute(cwd)) return null;
  let directory = path.resolve(cwd);
  try {
    if (!fs.statSync(directory).isDirectory()) return null;
    for (;;) {
      const configDirectory = path.join(directory, ".pomegr");
      const file = path.join(configDirectory, "usage-guard.json");
      if (fs.existsSync(file)) {
        if (fs.lstatSync(configDirectory).isSymbolicLink() || !regularFile(file, MAX_CONFIG_BYTES)) return null;
        const text = fs.readFileSync(file, "utf8");
        if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) return null;
        const config = normalizeUsageGuardConfig(JSON.parse(text));
        return config ? { config, repositoryRoot: directory } : null;
      }
      if (fs.existsSync(path.join(directory, ".git"))) return null;
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  } catch { return null; }
}

function readState(file, now) {
  try {
    if (!regularFile(file, 1024)) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.version !== 1 || !STAGES.has(value.stage)
      || !Number.isSafeInteger(value.lastCheckAt) || value.lastCheckAt < 0
      || value.lastCheckAt > now || now - value.lastCheckAt > STATE_TTL_MS
      || typeof value.configHash !== "string" || !/^[a-f0-9]{64}$/.test(value.configHash)) return null;
    return { version: 1, stage: value.stage, lastCheckAt: value.lastCheckAt, configHash: value.configHash };
  } catch { return null; }
}

function prune(directory, now) {
  const names = fs.readdirSync(directory);
  // Hooks can be killed between lock/temp creation and cleanup. Reclaim only
  // this module's allowlisted expired scratch files, including clock rollback.
  for (const name of names.filter((name) => COORDINATION_NAME.test(name))) {
    try {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && Math.abs(now - stat.mtimeMs) > 30_000) fs.unlinkSync(file);
    } catch { /* Another hook may have finished cleanup. */ }
  }
  const rows = names.filter((name) => STATE_NAME.test(name)).flatMap((name) => {
    try {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() ? [{ file, at: stat.mtimeMs }] : [];
    } catch { return []; }
  }).sort((a, b) => b.at - a.at);
  for (const [index, row] of rows.entries()) {
    if (index >= MAX_STATES - 1 || now - row.at > STATE_TTL_MS) {
      try { fs.unlinkSync(row.file); } catch { /* Another hook may own it. */ }
    }
  }
}

/** Hook subprocesses serialize one actor's checks, including parallel tool batches. */
export function openGuardState(dataRoot, identity, now) {
  const directory = path.join(dataRoot, "usage-guards");
  const file = path.join(directory, `${guardHash(identity)}.json`);
  const lockFile = `${file}.lock`;
  let lock = null;
  try {
    if (fs.existsSync(directory) && (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory())) return null;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    prune(directory, now);
    // Recover only this guard's own expired lock after a killed hook process.
    try {
      const stat = fs.lstatSync(lockFile);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      if (Math.abs(now - stat.mtimeMs) > 30_000) fs.unlinkSync(lockFile);
    } catch (error) { if (error?.code !== "ENOENT") return null; }
    lock = fs.openSync(lockFile, "wx", 0o600);
    fs.futimesSync(lock, new Date(now), new Date(now));
    return {
      previous: readState(file, now),
      save(value) {
        const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
        try {
          // Project only the fixed private state fields; no observations or content.
          const state = { version: 1, stage: value.stage, lastCheckAt: value.lastCheckAt, configHash: value.configHash };
          fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
          fs.renameSync(temporary, file);
          return true;
        } catch { return false; }
        finally { try { fs.unlinkSync(temporary); } catch { /* Already published. */ } }
      },
      close() {
        try { fs.closeSync(lock); } catch { /* Best effort. */ }
        try { fs.unlinkSync(lockFile); } catch { /* Bounded stale-lock recovery. */ }
      },
    };
  } catch {
    if (lock !== null) {
      try { fs.closeSync(lock); } catch { /* Best effort. */ }
      try { fs.unlinkSync(lockFile); } catch { /* Best effort. */ }
    }
    return null;
  }
}
