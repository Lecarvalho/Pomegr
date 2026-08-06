import fs from "node:fs";
import path from "node:path";

const USER_ATTENTION_REASONS = ["input", "approval", "permission", "question"];

function timestampMs(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeSessionRegistryEntry(value, fallbackUpdatedAt = 0) {
  if (!value || typeof value !== "object" || !/^[a-zA-Z0-9_-]+$/.test(value.sessionId || "")) return null;
  const status = typeof value.status === "string" ? value.status.trim().toLowerCase() : "";
  const waitingFor = typeof value.waitingFor === "string" ? value.waitingFor.trim().toLowerCase() : "";
  const updatedAt = Math.max(
    timestampMs(value.updatedAt),
    timestampMs(value.statusUpdatedAt),
    fallbackUpdatedAt,
  );
  const needsInput = status === "waiting"
    && USER_ATTENTION_REASONS.some((reason) => waitingFor.includes(reason));

  return { sessionId: value.sessionId, status, needsInput, updatedAt };
}

export function readSessionRegistry(root) {
  const registry = new Map();
  if (!root || !fs.existsSync(root)) return registry;

  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(root, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const entry = normalizeSessionRegistryEntry(JSON.parse(fs.readFileSync(file, "utf8")), stat.mtimeMs);
      if (!entry) continue;
      const current = registry.get(entry.sessionId);
      if (!current || entry.updatedAt >= current.updatedAt) registry.set(entry.sessionId, entry);
    } catch {
      // A partially-written or removed provider registry entry is ignored independently.
    }
  }

  return registry;
}

export function preferredRegisteredSessionId(registry, orderedSessionIds) {
  return orderedSessionIds.find((sessionId) => registry.get(sessionId)?.needsInput)
    || orderedSessionIds.find((sessionId) => {
      const status = registry.get(sessionId)?.status;
      return status === "active" || status === "waiting";
    })
    || null;
}
