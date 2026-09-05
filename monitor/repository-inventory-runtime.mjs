import { execFile as execFileCallback } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createCommittedResponseCache } from "./committed-response-cache.mjs";

const execFile = promisify(execFileCallback);
const STORE_VERSION = 1;
const MAX_REVISIONS_PER_TARGET = 10;
const MAX_REVISIONS = 100;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_BINDINGS = 500;
const SAFE_REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const SAFE_REVISION_ID = /^ctx-\d{3,9}$/u;
const SAFE_PROVIDER = /^(?:claude|codex)$/u;
const SAFE_FAILURES = new Set(["executable_unavailable", "timed_out", "invalid_output", "runtime_unavailable"]);

function safeText(value, maximum, fallback = "") {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized && normalized.length <= maximum ? normalized : fallback;
}

function safeTimestamp(value) {
  const milliseconds = Date.parse(value || "");
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizedInventory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = safeText(value.model, 256, "Unknown model");
  const categories = Array.isArray(value.categories) ? value.categories.slice(0, 128).flatMap((entry) => {
    const name = safeText(entry?.name, 128);
    const tokens = safeText(entry?.tokens, 64);
    const percentage = Number(entry?.percentage);
    return name && /^(?:~|< )?\d+(?:\.\d+)?[kKmM]?$/u.test(tokens)
      && Number.isFinite(percentage) && percentage >= 0 && percentage <= 100
      ? [{ name, tokens, percentage }] : [];
  }) : [];
  const groups = Array.isArray(value.groups) ? value.groups.slice(0, 12).flatMap((group, index) => {
    const label = safeText(group?.label, 128);
    if (!label || !Array.isArray(group?.items)) return [];
    const items = group.items.slice(0, 250).flatMap((item) => {
      const name = safeText(item?.name, 128);
      const detail = safeText(item?.detail, 512);
      const tokens = safeText(item?.tokens, 64);
      return name && /^(?:~|< )?\d+(?:\.\d+)?[kKmM]?$/u.test(tokens) ? [{ name, detail, tokens }] : [];
    });
    return items.length ? [{ id: `inventory-${index}`, label, items }] : [];
  }) : [];
  const machineryTokens = Number(value.machineryTokens);
  return categories.length && Number.isSafeInteger(machineryTokens) && machineryTokens >= 0
    ? { model, machineryTokens, categories, groups } : null;
}

function itemCount(revision) {
  return revision.groups.reduce((sum, group) => sum + group.items.length, 0);
}

function summary(revision, previous = null) {
  return {
    id: revision.id,
    capturedAt: revision.capturedAt,
    model: revision.model,
    machineryTokens: revision.machineryTokens,
    categoryCount: revision.categories.length,
    itemCount: itemCount(revision),
    change: previous ? {
      state: previous.fingerprint === revision.fingerprint ? "unchanged" : "changed",
      previousRevisionId: previous.id,
    } : { state: "first_capture", previousRevisionId: null },
  };
}

function safePersistedState(value, fallbackNow) {
  if (!value || value.version !== STORE_VERSION || typeof value.salt !== "string" || !/^[a-f0-9]{64}$/u.test(value.salt)) return null;
  const introducedAt = safeTimestamp(value.introducedAt) || new Date(fallbackNow()).toISOString();
  const counters = {};
  for (const [key, count] of Object.entries(value.counters || {})) {
    if (/^repo-[a-f0-9]{24}\|(?:claude|codex)$/u.test(key) && Number.isSafeInteger(count) && count >= 0) counters[key] = count;
  }
  const revisions = Array.isArray(value.revisions) ? value.revisions.slice(0, MAX_REVISIONS).flatMap((entry) => {
    if (!SAFE_REPOSITORY_ID.test(entry?.repositoryId || "") || !SAFE_PROVIDER.test(entry?.provider || "")
      || !SAFE_REVISION_ID.test(entry?.id || "") || !safeTimestamp(entry?.capturedAt)
      || typeof entry?.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(entry.fingerprint)) return [];
    const inventory = normalizedInventory(entry);
    return inventory ? [{ repositoryId: entry.repositoryId, provider: entry.provider, id: entry.id,
      capturedAt: safeTimestamp(entry.capturedAt), fingerprint: entry.fingerprint, ...inventory }] : [];
  }) : [];
  const bindings = Array.isArray(value.bindings) ? value.bindings.slice(-MAX_BINDINGS).flatMap((entry) => {
    if (!/^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry?.sessionId || "")
      || !SAFE_REPOSITORY_ID.test(entry?.repositoryId || "") || !SAFE_PROVIDER.test(entry?.provider || "")
      || !safeTimestamp(entry?.evaluatedAt)) return [];
    const reference = entry.reference === null ? null : (() => {
      const value = entry.reference;
      return value && SAFE_REVISION_ID.test(value.revisionId || "") && safeTimestamp(value.capturedAt)
        ? { repositoryId: entry.repositoryId, provider: entry.provider, revisionId: value.revisionId,
          capturedAt: safeTimestamp(value.capturedAt), model: safeText(value.model, 256, "Unknown model"),
          machineryTokens: Number.isSafeInteger(value.machineryTokens) ? value.machineryTokens : 0,
          categoryCount: Number.isSafeInteger(value.categoryCount) ? value.categoryCount : 0,
          itemCount: Number.isSafeInteger(value.itemCount) ? value.itemCount : 0, detailRetained: Boolean(value.detailRetained) }
        : undefined;
    })();
    return reference === undefined ? [] : [{ sessionId: entry.sessionId, repositoryId: entry.repositoryId,
      provider: entry.provider, evaluatedAt: safeTimestamp(entry.evaluatedAt), reference }];
  }) : [];
  return { version: STORE_VERSION, introducedAt, salt: value.salt, counters, revisions, bindings };
}

function freshState(now) {
  return {
    version: STORE_VERSION,
    introducedAt: new Date(now()).toISOString(),
    salt: randomBytes(32).toString("hex"),
    counters: {},
    revisions: [],
    bindings: [],
  };
}

function targetKey(repositoryId, provider) {
  return `${repositoryId}|${provider}`;
}

function prune(state) {
  const newest = [...state.revisions].sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));
  const counts = new Map();
  let revisions = newest.filter((entry) => {
    const key = targetKey(entry.repositoryId, entry.provider);
    const count = counts.get(key) || 0;
    counts.set(key, count + 1);
    return count < MAX_REVISIONS_PER_TARGET;
  }).slice(0, MAX_REVISIONS);
  while (revisions.length > 1 && Buffer.byteLength(JSON.stringify({ ...state, revisions }), "utf8") > MAX_STORE_BYTES) revisions.pop();
  return { ...state, revisions };
}

export function createRepositoryInventoryRuntime(options = {}) {
  const registry = options.registry;
  if (!registry) throw new TypeError("Repository inventory runtime requires a provider registry");
  const now = options.now || Date.now;
  const persistence = options.persistence !== false;
  const storeFile = options.storeFile;
  if (typeof storeFile !== "string" || !path.isAbsolute(storeFile)) throw new TypeError("Repository inventory store requires an absolute file path");
  const gitRoot = options.gitRoot || (async (cwd) => {
    try {
      const { stdout } = await execFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024,
      });
      const root = path.resolve(String(stdout || "").trim());
      return path.isAbsolute(root) ? root : path.resolve(cwd);
    } catch { return path.resolve(cwd); }
  });
  const cache = createCommittedResponseCache({ includeRevision: true, now });
  const targets = new Map();
  const roots = new Map();
  const captureStates = new Map();
  const subscribers = new Set();
  let state;
  let catalog = [];
  let lastProjection = "";
  let mutationQueue = Promise.resolve();

  async function persist(candidate) {
    if (!persistence) return;
    await mkdir(path.dirname(storeFile), { recursive: true });
    const temporary = `${storeFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(candidate), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, storeFile);
      try { await copyFile(storeFile, `${storeFile}.bak`); } catch { /* backup is best-effort after the atomic commit */ }
    } catch (error) {
      try { await unlink(temporary); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }

  const ready = (async () => {
    let loaded = null;
    if (persistence) try { loaded = safePersistedState(JSON.parse(await readFile(storeFile, "utf8")), now); } catch { /* first run or invalid store */ }
    if (persistence && !loaded) {
      try { loaded = safePersistedState(JSON.parse(await readFile(`${storeFile}.bak`, "utf8")), now); } catch { /* no valid backup */ }
    }
    state = loaded || freshState(now);
  })();

  async function commitState(transform) {
    const operation = mutationQueue.then(async () => {
      const candidate = prune(transform(state));
      await persist(candidate);
      state = candidate;
      return candidate;
    });
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  function revisionsFor(repositoryId, provider) {
    return state.revisions
      .filter((entry) => entry.repositoryId === repositoryId && entry.provider === provider)
      .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));
  }

  function referenceFor(revision) {
    if (!revision) return null;
    return {
      repositoryId: revision.repositoryId,
      provider: revision.provider,
      revisionId: revision.id,
      capturedAt: revision.capturedAt,
      model: revision.model,
      machineryTokens: revision.machineryTokens,
      categoryCount: revision.categories.length,
      itemCount: itemCount(revision),
      detailRetained: state.revisions.some((entry) => entry.repositoryId === revision.repositoryId
        && entry.provider === revision.provider && entry.id === revision.id),
    };
  }

  function normalizeReference(value, provider, repositoryId) {
    if (!value || value.provider !== provider || value.repositoryId !== repositoryId || !SAFE_REVISION_ID.test(value.revisionId || "")) return null;
    const retained = state.revisions.find((entry) => entry.repositoryId === repositoryId && entry.provider === provider && entry.id === value.revisionId);
    return retained ? referenceFor(retained) : {
      repositoryId, provider, revisionId: value.revisionId,
      capturedAt: safeTimestamp(value.capturedAt), model: safeText(value.model, 256, "Unknown model"),
      machineryTokens: Number.isSafeInteger(value.machineryTokens) ? value.machineryTokens : 0,
      categoryCount: Number.isSafeInteger(value.categoryCount) ? value.categoryCount : 0,
      itemCount: Number.isSafeInteger(value.itemCount) ? value.itemCount : 0,
      detailRetained: false,
    };
  }

  async function identify(cwd) {
    await ready;
    const normalizedCwd = path.resolve(cwd);
    let root = roots.get(normalizedCwd);
    if (!root) {
      root = await gitRoot(normalizedCwd);
      roots.set(normalizedCwd, root);
    }
    const identityRoot = process.platform === "win32" ? root.toLowerCase() : root;
    const repositoryId = `repo-${createHmac("sha256", Buffer.from(state.salt, "hex")).update(identityRoot).digest("hex").slice(0, 24)}`;
    const name = safeText(path.basename(root), 128, "Repository");
    targets.set(repositoryId, { root, name });
    return { repositoryId, name };
  }

  async function associateSession({ sessionId, provider, startedAt, cwd, previousReference = null }) {
    await ready;
    const { repositoryId } = await identify(cwd);
    const storedBinding = state.bindings.find((entry) => entry.sessionId === sessionId);
    if (storedBinding) return {
      repositoryId,
      contextInventoryRef: storedBinding.repositoryId === repositoryId && storedBinding.provider === provider
        ? normalizeReference(storedBinding.reference, provider, repositoryId) : null,
    };
    const previous = normalizeReference(previousReference, provider, repositoryId);
    if (previous) return { repositoryId, contextInventoryRef: previous };
    const startedMs = Date.parse(startedAt || "");
    const eligible = Number.isFinite(startedMs) && startedMs >= Date.parse(state.introducedAt)
      ? revisionsFor(repositoryId, provider).find((entry) => Date.parse(entry.capturedAt) <= startedMs) : null;
    const reference = referenceFor(eligible);
    if (/^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sessionId || "")) {
      try {
        await commitState((current) => ({ ...current, bindings: [...current.bindings, {
          sessionId, repositoryId, provider, evaluatedAt: new Date(now()).toISOString(), reference,
        }].slice(-MAX_BINDINGS) }));
      } catch { /* a binding persistence failure degrades to no reference */ }
    }
    return { repositoryId, contextInventoryRef: reference };
  }

  function revisionSummaries(repositoryId, provider) {
    const entries = revisionsFor(repositoryId, provider);
    return entries.map((entry, index) => summary(entry, entries[index + 1] || null));
  }

  function projection() {
    const grouped = new Map();
    for (const session of catalog) {
      if (!SAFE_REPOSITORY_ID.test(session?.repositoryId || "")) continue;
      const group = grouped.get(session.repositoryId) || [];
      group.push(session);
      grouped.set(session.repositoryId, group);
    }
    const nameCounts = new Map();
    for (const repositoryId of grouped.keys()) {
      const name = targets.get(repositoryId)?.name || grouped.get(repositoryId)?.[0]?.project || "Repository";
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    }
    return [...grouped].map(([repositoryId, sessions]) => {
      const target = targets.get(repositoryId);
      const name = target?.name || safeText(sessions[0]?.project, 128, "Repository");
      const providerOrder = new Map((registry.providers || []).map((entry, index) => [entry.id, index]));
      const providers = [...new Set(sessions.map((session) => session.provider).filter((provider) => SAFE_PROVIDER.test(provider)))]
        .sort((left, right) => (providerOrder.get(left) ?? 99) - (providerOrder.get(right) ?? 99))
        .map((providerId) => {
        const provider = registry.providers?.find((entry) => entry.id === providerId);
        const revisions = revisionSummaries(repositoryId, providerId);
        const transient = captureStates.get(targetKey(repositoryId, providerId));
        const supported = provider?.capabilities?.repositoryContextInventory === true;
        const status = !supported ? "unavailable" : transient?.status || (revisions.length ? "current" : "not_captured");
        return {
          provider: providerId,
          source: provider?.source || providerId,
          sessionCount: sessions.filter((session) => session.provider === providerId).length,
          supported,
          status,
          failureKind: transient?.failureKind || null,
          currentRevision: revisions[0] || null,
          revisions,
        };
        });
      const updatedAt = sessions.map((entry) => entry.updatedAt).filter(Boolean).sort().at(-1) || null;
      return {
        id: repositoryId,
        name,
        displayName: nameCounts.get(name) > 1 ? `${name} · ${repositoryId.slice(-4)}` : name,
        sessionCount: sessions.length,
        liveCount: sessions.filter((entry) => entry.isLive).length,
        historyCount: sessions.filter((entry) => !entry.isLive).length,
        providerCount: providers.length,
        updatedAt,
        providers,
      };
    }).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  function commitProjection(force = false) {
    if (!state) return;
    const value = { readiness: "ready", repositories: projection() };
    const serialized = JSON.stringify(value);
    if (!force && serialized === lastProjection) return;
    lastProjection = serialized;
    const committed = cache.commit(value);
    for (const subscriber of subscribers) {
      try { subscriber({ domain: "repositories", revision: committed.revision }); } catch { /* isolated */ }
    }
  }

  async function reconcile(nextCatalog = []) {
    await ready;
    catalog = Array.isArray(nextCatalog) ? nextCatalog : [];
    commitProjection();
  }

  async function capture(repositoryId, providerId) {
    await ready;
    if (!SAFE_REPOSITORY_ID.test(repositoryId || "") || !SAFE_PROVIDER.test(providerId || "")) return "failed";
    const key = targetKey(repositoryId, providerId);
    if (captureStates.get(key)?.status === "capturing") return "busy";
    const target = targets.get(repositoryId);
    const provider = registry.providers?.find((entry) => entry.id === providerId);
    if (!target || !provider?.capabilities?.repositoryContextInventory || typeof provider.captureRepositoryContextInventory !== "function") return "unavailable";
    captureStates.set(key, { status: "capturing", failureKind: null });
    commitProjection(true);
    let result;
    try { result = await provider.captureRepositoryContextInventory({ cwd: target.root }); }
    catch { result = { status: "failed", failureKind: "runtime_unavailable" }; }
    if (result?.status !== "completed") {
      const status = ["timed_out", "unavailable"].includes(result?.status) ? result.status : "failed";
      const failureKind = SAFE_FAILURES.has(result?.failureKind) ? result.failureKind : "runtime_unavailable";
      captureStates.set(key, { status: "failed", failureKind });
      commitProjection(true);
      return status;
    }
    const inventory = normalizedInventory(result.inventory);
    if (!inventory) {
      captureStates.set(key, { status: "failed", failureKind: "invalid_output" });
      commitProjection(true);
      return "failed";
    }
    const nextCount = (state.counters[key] || 0) + 1;
    const capturedAt = safeTimestamp(result.inventory.observedAt) || new Date(now()).toISOString();
    const fingerprint = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
    const revision = { repositoryId, provider: providerId, id: `ctx-${String(nextCount).padStart(3, "0")}`,
      capturedAt, fingerprint, ...inventory };
    try { await commitState((current) => ({ ...current, counters: { ...current.counters, [key]: nextCount }, revisions: [...current.revisions, revision] })); }
    catch {
      captureStates.set(key, { status: "failed", failureKind: "runtime_unavailable" });
      commitProjection(true);
      return "failed";
    }
    captureStates.delete(key);
    commitProjection(true);
    return "completed";
  }

  async function readRevision(repositoryId, provider, revisionId) {
    await ready;
    if (!SAFE_REPOSITORY_ID.test(repositoryId || "") || !SAFE_PROVIDER.test(provider || "") || !SAFE_REVISION_ID.test(revisionId || "")) return null;
    const entries = revisionsFor(repositoryId, provider);
    const index = entries.findIndex((entry) => entry.id === revisionId);
    if (index < 0) return null;
    const entry = entries[index];
    return { repositoryId, provider, ...summary(entry, entries[index + 1] || null), categories: entry.categories, groups: entry.groups };
  }

  return Object.freeze({
    ready,
    identify,
    associateSession,
    reconcile,
    capture,
    readRepositories: (revision) => cache.read(revision),
    readRevision,
    subscribe(subscriber) { subscribers.add(subscriber); return () => subscribers.delete(subscriber); },
    introducedAt: async () => { await ready; return state.introducedAt; },
  });
}
