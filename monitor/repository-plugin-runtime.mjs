import { open, lstat } from "node:fs/promises";
import path from "node:path";
import { validatePolicyText } from "../plugins/pomegr/scripts/policy.mjs";
import { comparePluginVersions, emptyRepositoryPluginSetup, pluginVersionSchema, repositoryPluginSetupSchema, repositoryReportingSchema } from "../shared/repository-plugin-state.mjs";
import { createRepositoryPluginReleaseReader } from "./repository-plugin-releases.mjs";

const MAX_TARGETS = 200;
const safeRef = (value) => typeof value === "string" && /^(?:main|v\d{1,4}\.\d{1,4}\.\d{1,4}|[a-f0-9]{40})$/u.test(value);

async function readReporting(root, now) {
  const checkedAt = new Date(now()).toISOString();
  try {
    if (!(await lstat(root)).isDirectory()) return { status: "unknown", version: null, checkedAt: null };
  } catch { return { status: "unknown", version: null, checkedAt: null }; }
  try {
    const file = path.join(root, ".pomegr", "signals.md");
    const directory = await lstat(path.dirname(file));
    const stat = await lstat(file);
    if (directory.isSymbolicLink() || stat.isSymbolicLink() || !stat.isFile() || stat.size > 24 * 1024) return { status: "invalid", version: null, checkedAt };
    const handle = await open(file, "r");
    let result;
    try { const buffer = Buffer.alloc(24 * 1024 + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      result = bytesRead > 24 * 1024 ? null : validatePolicyText(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally { await handle.close(); }
    return { status: result?.status === "valid" ? "configured" : "invalid", version: [6, 7].includes(result?.version) ? result.version : null, checkedAt };
  } catch (error) { return { status: error?.code === "ENOENT" ? "missing" : "unknown", version: null, checkedAt }; }
}

/** Bounded independent current-configuration observation. No GET invokes this work. */
export function createRepositoryPluginRuntime(options = {}) {
  const now = options.now || Date.now;
  const release = options.readRelease || createRepositoryPluginReleaseReader({ now, fetch: options.fetch });
  const readPolicy = options.readReporting || readReporting;
  const entries = new Map(); const policies = new Map(); const actionPlans = new Map(); const inFlight = new Map();
  let targets = new Map(); let timer = null; let active = false; let fullRefresh = null; let refreshRequested = false;
  let stopping = false;
  const keyFor = (id, provider) => `${id}:${provider}`;
  const notify = () => options.onChange?.();

  async function inspect(target, providerId) {
    const key = keyFor(target.id, providerId);
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = (async () => {
      const previous = entries.get(key);
      let next;
      try {
        const provider = options.registry.providers.find((entry) => entry.id === providerId);
        const result = await provider?.readRepositoryPluginSetup?.({ cwd: target.root });
        if (stopping) throw new Error("unavailable");
        if (!result || !["installed", "not_installed"].includes(result.installation)) throw new Error("unavailable");
        const version = result.installation === "installed" ? pluginVersionSchema.parse(result.version) : null;
        const scope = ["user", "project", "local"].includes(result.scope) ? result.scope : null;
        const enabled = typeof result.enabled === "boolean" ? result.enabled : null;
        const trusted = result.privateAction?.sourceTrusted === true;
        const ref = result.privateAction?.ref || "main";
        const pinned = ref !== "main";
        const published = trusted && safeRef(ref) ? await release(providerId, ref) : { status: "unavailable", version: null, checkedAt: null };
        const latest = published.version && pluginVersionSchema.safeParse(published.version).success ? published.version : null;
        const comparison = version && latest ? comparePluginVersions(version, latest) : null;
        const updateStatus = published.status !== "ready" ? "unavailable"
          : comparison !== null && comparison < 0 ? "available" : pinned ? "pinned" : version ? "current" : "unknown";
        const planAllowed = trusted && safeRef(ref) && published.status === "ready" && latest && (scope !== null || result.installation === "not_installed");
        next = repositoryPluginSetupSchema.parse({ readiness: "ready", installation: result.installation, version, enabled, scope,
          checkedAt: new Date(now()).toISOString(), update: { status: updateStatus, version: latest, checkedAt: published.checkedAt },
          canInstall: Boolean(planAllowed && result.installation === "not_installed"),
          canUpdate: Boolean(planAllowed && updateStatus === "available" && result.installation === "installed" && (providerId !== "codex" || enabled === true)),
        });
        if (planAllowed) actionPlans.set(key, { root: target.root, repositoryName: target.name, provider: providerId,
          scope: scope || (providerId === "claude" ? "project" : "user"), currentVersion: version, targetVersion: latest,
          marketplaceRegistered: result.privateAction.marketplaceRegistered === true, ref });
        else actionPlans.delete(key);
      } catch {
        next = { ...(previous || emptyRepositoryPluginSetup("unavailable")), readiness: "unavailable", canInstall: false, canUpdate: false };
        actionPlans.delete(key);
      }
      if (targets.get(target.id)?.root !== target.root) return "unavailable";
      entries.set(key, Object.freeze(next)); notify();
      return next.readiness === "ready" ? "completed" : "unavailable";
    })();
    inFlight.set(key, operation);
    try { return await operation; } finally { inFlight.delete(key); }
  }

  async function inspectPolicy(target) {
    const result = await readPolicy(target.root, now).catch(() => ({ status: "unknown", version: null, checkedAt: null }));
    if (targets.get(target.id)?.root !== target.root) return;
    const normalized = repositoryReportingSchema.safeParse(result);
    if (normalized.success) {
      const previous = policies.get(target.id);
      policies.set(target.id, normalized.data.status === "unknown" && previous ? { ...previous, status: "unknown" } : normalized.data); notify();
    }
  }

  async function refresh(repositoryId, providerId) {
    const target = targets.get(repositoryId);
    if (!target || !target.providers.includes(providerId)) return "unavailable";
    const [status] = await Promise.all([inspect(target, providerId), inspectPolicy(target)]);
    return status;
  }

  function refreshAll() {
    refreshRequested = true;
    if (fullRefresh) return fullRefresh;
    fullRefresh = (async () => {
      while (active && refreshRequested) {
        refreshRequested = false;
        for (const target of targets.values()) {
          if (!active) return;
          await Promise.allSettled([inspectPolicy(target), ...target.providers.map((provider) => inspect(target, provider))]);
        }
      }
    })().finally(() => { fullRefresh = null; });
    return fullRefresh;
  }

  function syncTargets(values) {
    const previous = targets;
    targets = new Map(values.slice(0, MAX_TARGETS).map((entry) => [entry.id, entry]));
    for (const key of entries.keys()) if (![...targets.values()].some((target) => target.providers.some((provider) => keyFor(target.id, provider) === key))) { entries.delete(key); actionPlans.delete(key); }
    for (const id of policies.keys()) if (!targets.has(id)) policies.delete(id);
    if (active && [...targets.values()].some((target) => !previous.has(target.id)
      || target.providers.some((provider) => !previous.get(target.id).providers.includes(provider)))) void refreshAll();
  }

  return Object.freeze({
    syncTargets,
    start() { if (active) return; stopping = false; active = true; void refreshAll(); timer = setInterval(() => { void refreshAll(); }, 60_000); timer.unref?.(); },
    async stop() { stopping = true; active = false; clearInterval(timer); timer = null; release.stop?.(); await Promise.allSettled([...inFlight.values(), fullRefresh].filter(Boolean)); },
    read: (id, provider) => entries.get(keyFor(id, provider)) || emptyRepositoryPluginSetup(targets.has(id) ? "loading" : "unavailable"),
    reporting: (id) => policies.get(id) || { status: "unknown", version: null, checkedAt: null },
    refresh,
    async prepare(repositoryId, providerId, operation) {
      if (!["install", "update"].includes(operation)) return null;
      if (await refresh(repositoryId, providerId) !== "completed") return null;
      const key = keyFor(repositoryId, providerId); const setup = entries.get(key);
      if (!(operation === "install" ? setup?.canInstall : setup?.canUpdate)) return null;
      return actionPlans.has(key) ? { ...actionPlans.get(key), operation } : null;
    },
  });
}
