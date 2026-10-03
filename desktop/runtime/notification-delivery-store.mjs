import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

const VERSION = 1;
const MAX_CLAIMS = 512;
const MAX_BYTES = 64 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const ID = /^[a-f0-9]{32}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** The effective native folder profile is hashed; raw roots never reach the claim file. */
export function notificationDeliveryProfile(folders) {
  const values = ["claudeConfigDir", "claudeProjectsDir", "codexHome"].map((key) => folders?.[key]);
  if (values.some((value) => typeof value !== "string" || !value || value.length > 4096)) throw new TypeError("Invalid delivery profile");
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function normalizeNotificationDeliveryRecord(value, profileScope, now) {
  if (typeof profileScope !== "string" || !HASH.test(profileScope)
    || !exact(value, ["version", "profileScope", "initialized", "claims"])
    || value.version !== VERSION || typeof value.profileScope !== "string" || !HASH.test(value.profileScope)
    || typeof value.initialized !== "boolean"
    || !Array.isArray(value.claims) || value.claims.length > MAX_CLAIMS || !Number.isFinite(now)) return null;
  const seen = new Set();
  for (const claim of value.claims) {
    if (!exact(claim, ["id", "claimedAt"]) || typeof claim.id !== "string" || !ID.test(claim.id) || seen.has(claim.id)
      || !Number.isSafeInteger(claim.claimedAt) || claim.claimedAt < 0 || claim.claimedAt > now + 60_000) return null;
    seen.add(claim.id);
  }
  if (!value.initialized && value.claims.length) return null;
  return { profileMatches: value.profileScope === profileScope,
    record: { version: VERSION, profileScope, initialized: value.initialized,
      claims: value.claims.filter((claim) => now - claim.claimedAt <= RETENTION_MS) } };
}

/** One native owner's bounded, atomic claim ledger. A failed claim never changes memory. */
export function createNotificationDeliveryStore({ file, profileScope, now = Date.now, filesystem = fs } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || typeof profileScope !== "string" || !HASH.test(profileScope)) throw new TypeError("Invalid delivery store configuration");
  let loaded = false;
  let writable = false;
  let record = { version: VERSION, profileScope, initialized: false, claims: [] };

  async function load() {
    if (loaded) throw new TypeError("Delivery store already loaded");
    loaded = true;
    try {
      const info = await filesystem.stat(file);
      if (info.size > MAX_BYTES) return "invalid";
      const contents = await filesystem.readFile(file, "utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_BYTES) return "invalid";
      const parsed = normalizeNotificationDeliveryRecord(JSON.parse(contents), profileScope, now());
      if (!parsed) return "invalid";
      writable = true;
      if (parsed.profileMatches) { record = parsed.record; return "restored"; }
      return "profile_changed";
    } catch (error) {
      if (error?.code === "ENOENT") { writable = true; return "missing"; }
      return "invalid";
    }
  }

  async function claim(ids) {
    if (!loaded || !writable || !Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== "string" || !ID.test(id))) return false;
    const clock = now();
    if (!Number.isSafeInteger(clock) || clock < 0) return false;
    const existing = record.claims.filter((entry) => clock - entry.claimedAt <= RETENTION_MS);
    const seen = new Set(existing.map((entry) => entry.id));
    for (const id of ids) if (!seen.has(id)) { existing.push({ id, claimedAt: clock }); seen.add(id); }
    const candidate = { version: VERSION, profileScope, initialized: true, claims: existing.slice(-MAX_CLAIMS) };
    if (!normalizeNotificationDeliveryRecord(candidate, profileScope, clock)) return false;
    const serialized = `${JSON.stringify(candidate)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) return false;
    let temporary;
    try {
      await filesystem.mkdir(path.dirname(file), { recursive: true });
      temporary = `${file}.${randomUUID()}.tmp`;
      await filesystem.writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await filesystem.rename(temporary, file);
      record = candidate;
      return true;
    } catch { return false; }
    finally { if (temporary) await filesystem.unlink(temporary).catch(() => {}); }
  }

  return Object.freeze({ load, claim, has: (id) => record.claims.some((entry) => entry.id === id),
    initialized: () => record.initialized, writable: () => writable });
}
