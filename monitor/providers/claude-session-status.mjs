import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeSessionRegistryEntry } from "../session-registry.mjs";

const STATUS_INTERVAL_MS = 10_000;
const FAILURE_RETRY_MS = 60_000;
const MAX_STATUS_ENTRIES = 50;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REMOTE_ID = /^(?:session|cse)_[A-Za-z0-9]{1,120}$/;

function remoteIdentity(value) {
  return typeof value === "string" && REMOTE_ID.test(value) ? value.replace(/^(?:session|cse)_/, "") : null;
}

// Provider transport identities stay inside the adapter, never in catalog/evidence.
export function normalizeClaudeSessionRegistryEntry(value, updatedAt) {
  const entry = normalizeSessionRegistryEntry(value, updatedAt);
  const ownerStart = typeof value?.startedAt === "number" ? value.startedAt : Date.parse(value?.startedAt || "");
  if (entry && Number.isFinite(ownerStart) && ownerStart > 0) entry.ownerStartedAt = ownerStart;
  if (entry && value.entrypoint === "sdk-cli" && remoteIdentity(value.bridgeSessionId)) {
    return { ...entry, remoteSessionId: value.bridgeSessionId };
  }
  return entry;
}

export function registryStatus(entry, fallback) {
  if (["active", "waiting", "idle"].includes(entry?.status)) return entry.status;
  return entry?.remoteSessionId ? "unknown" : fallback;
}

export function registryTimestamp(entry) {
  return entry?.updatedAt ? new Date(entry.updatedAt).toISOString() : null;
}

export function sessionActivityStatus(isLive, entry, backgroundRunning = null) {
  // Non-live catalog fallback; this does not assert provider-confirmed completion.
  if (!isLive) return "idle";
  if (entry?.needsInput) return "needs_input";
  if (entry?.status === "active" || entry?.status === "waiting" || backgroundRunning === true) return "working";
  // A validated owner proves the interactive runtime is still open even when
  // the primary worker has become idle between turns. Keep that distinction
  // at the session level; individual agents retain their native idle status.
  if (entry?.status === "idle" && entry?.resourceOwner) return "open";
  return entry?.status === "idle" ? "idle" : "unknown";
}

// Registry and transport transitions invalidate hydration without transcript growth.
// Only normalized lifecycle contributes; no process, registry, or remote identity.
export function claudeLifecycleSource(source, entry) {
  if (!source) return source;
  return { ...source, identity: crypto.createHash("sha256")
    .update(JSON.stringify([source.identity, Boolean(source.historical), registryStatus(entry, "unknown"), Boolean(entry?.needsInput)]))
    .digest("hex") };
}

function accessToken(homeDir) {
  try {
    const file = path.join(homeDir, ".claude", ".credentials.json");
    if (fs.statSync(file).size > 64 * 1024) return null;
    const token = JSON.parse(fs.readFileSync(file, "utf8"))?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 && token.length <= 16_384 ? token : null;
  } catch { return null; }
}

async function boundedJson(response) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return null;
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); }
}

function statusFromResponse(body, remoteId) {
  const session = body?.response_shape ?? body?.session;
  if (!session || remoteIdentity(session.id) !== remoteIdentity(remoteId)
    || session.status === "archived") return null;
  switch (session.worker_status) {
    case "running": return { status: "active", needsInput: false };
    case "requires_action": return { status: "waiting", needsInput: true };
    case "idle": return { status: "idle", needsInput: false };
    default: return null;
  }
}

/** Read-only Remote Control metadata, acquired only by background provider work.
 * Never list remote sessions, attach to a worker, refresh credentials, or read events.
 * Cache only normalized lifecycle; raw response bodies die with each bounded request.
 */
export function createClaudeSessionStatusReader({ homeDir, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const cache = new Map();
  let credentialIdentity = null;
  let activeRequests = 0;
  const waiters = [];

  async function request(remoteId, token) {
    if (activeRequests >= 4) await new Promise((resolve) => waiters.push(resolve));
    else activeRequests += 1;
    try {
      const response = await fetchImpl("https://api.anthropic.com/v1/code/sessions/" + remoteId, {
        method: "GET",
        headers: { Authorization: "Bearer " + token, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(6_000),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return null;
      }
      return statusFromResponse(await boundedJson(response), remoteId);
    } catch {
      // Neither raw failures nor the URL/credential may enter logs or API state.
      return null;
    } finally {
      const resume = waiters.shift();
      if (resume) resume();
      else activeRequests -= 1;
    }
  }

  function association(entry) {
    const owner = entry?.resourceOwner;
    return owner && remoteIdentity(entry.remoteSessionId)
      ? JSON.stringify([entry.sessionId, owner.pid, owner.processStartIdentity, entry.remoteSessionId]) : null;
  }

  function apply(registry, localIds) {
    for (const id of localIds) {
      const entry = registry.get(id);
      const cached = cache.get(id);
      if (cached?.value && association(entry) === cached.key) Object.assign(entry, cached.value);
    }
  }

  async function refresh(registry, localIds) {
    const current = new Map([...registry].flatMap(([id, entry]) => {
      const key = association(entry);
      return key ? [[id, key]] : [];
    }));
    for (const [id, item] of cache) if (current.get(id) !== item.key) cache.delete(id);
    const eligible = [...new Set(localIds)].filter((id) => current.has(id)).slice(0, MAX_STATUS_ENTRIES);
    if (!eligible.length) return;
    const token = accessToken(homeDir);
    const identity = token ? crypto.createHash("sha256").update(token).digest("hex") : null;
    if (identity !== credentialIdentity) { cache.clear(); credentialIdentity = identity; }
    if (!token) return;

    await Promise.all(eligible.map(async (id) => {
      const entry = registry.get(id);
      const key = current.get(id);
      let cached = cache.get(id);
      if (!cached) {
        if (cache.size >= MAX_STATUS_ENTRIES) {
          const victim = [...cache].find(([key, value]) => !value.pending && !eligible.includes(key));
          if (!victim) return;
          cache.delete(victim[0]);
        }
        cached = { key, value: null, nextReadAt: 0, pending: null };
        cache.set(id, cached);
      }
      if (!cached.pending && now() >= cached.nextReadAt) {
        const item = cached;
        item.pending = request(entry.remoteSessionId, token).then((value) => {
          if (value && (item.value?.status !== value.status || item.value?.needsInput !== value.needsInput)) {
            item.value = { ...value, updatedAt: now() };
          }
          item.nextReadAt = now() + (value ? STATUS_INTERVAL_MS : FAILURE_RETRY_MS);
        }).finally(() => { item.pending = null; });
      }
      await cached.pending;
      // An older in-flight request cannot overwrite a reassigned owner or credential.
      if (cache.get(id) === cached && credentialIdentity === identity && cached.value) Object.assign(entry, cached.value);
    }));
  }

  return { refresh, apply };
}
