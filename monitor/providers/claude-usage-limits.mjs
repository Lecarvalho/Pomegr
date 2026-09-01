import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUsageLimitsCoordinator } from "../usage-limits.mjs";
import { claudeUsageLimitsFromSnapshot, claudeUsageSnapshotsRoot, readClaudeUsageSnapshot } from "./claude-usage-feed.mjs";

function usageRequest(configDir, fetchImpl) {
  return async () => {
    const credentials = JSON.parse(fs.readFileSync(path.join(configDir, ".credentials.json"), "utf8"));
    const token = credentials.claudeAiOauth?.accessToken;
    if (!token) throw new Error("Claude OAuth session not found");
    return fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "user-agent": "pomegr/0.1",
      },
      signal: AbortSignal.timeout(6000),
    });
  };
}

/** Coordinates complete local and provider usage observations without mixing windows. */
export function createClaudeUsageLimitsReader(options = {}) {
  const environment = options.env ?? process.env;
  const homeDir = options.homeDir || os.homedir();
  const now = options.now || (() => Date.now());
  const configDir = options.claudeConfigDir || environment.CLAUDE_CONFIG_DIR || path.join(homeDir, ".claude");
  const snapshotsRoot = options.usageSnapshotsRoot || claudeUsageSnapshotsRoot({ environment, homeDir, platform: options.platform });
  const remote = createUsageLimitsCoordinator({
    request: options.usageRequest || usageRequest(configDir, options.fetch || globalThis.fetch),
    now,
  });
  const freshMs = options.usageFeedFreshMs ?? 5 * 60_000;
  let retainedLocal = null;
  let newestSuccessful = null;
  let retainedModelLimits = null;
  let lastRemoteTimestamp = -1;
  let latestRemote = null;

  function timestamp(value) {
    const parsed = Date.parse(value?.fetchedAt || "");
    return Number.isFinite(parsed) ? parsed : -1;
  }

  function retainNewest(candidate) {
    if (candidate && timestamp(candidate) > timestamp(newestSuccessful)) newestSuccessful = candidate;
    return newestSuccessful;
  }

  function retainModelLimits(candidate) {
    if (timestamp(candidate) <= lastRemoteTimestamp) return;
    lastRemoteTimestamp = timestamp(candidate);
    const model = candidate.limits.find((limit) => limit.id === "model-fable");
    retainedModelLimits = model ? { fetchedAt: candidate.fetchedAt, limits: [model] } : null;
  }

  function acceptRemote(usage) {
    if (!latestRemote || Date.parse(usage.attemptedAt || "") >= Date.parse(latestRemote.attemptedAt || "")) latestRemote = usage;
    if (!usage.available || usage.failureKind !== null || usage.error || timestamp(usage) < 0) return null;
    const candidate = { ...usage, origin: "provider_api" };
    retainNewest(candidate);
    retainModelLimits(candidate);
    return candidate;
  }

  function withRetainedLimits(usage) {
    // Never fold old model usage into a newer account observation or activity sample.
    return usage.origin === "local_observation" && retainedModelLimits
      ? { ...usage, retainedLimits: retainedModelLimits }
      : usage;
  }

  function freshness(usage, requireCurrentResets = false) {
    const observed = timestamp(usage);
    const current = now();
    const currentResets = Array.isArray(usage?.limits) && usage.limits.length > 0
      && usage.limits.every((limit) => Number.isFinite(Date.parse(limit?.resetsAt || "")) && Date.parse(limit.resetsAt) > current);
    return observed >= 0 && observed <= current && current - observed <= freshMs
      && (!requireCurrentResets || currentResets) ? "fresh" : "stale";
  }

  function local() {
    const current = claudeUsageLimitsFromSnapshot(readClaudeUsageSnapshot({ root: snapshotsRoot, now }), { freshness: "fresh" });
    if (current && timestamp(current) >= timestamp(retainedLocal)) retainedLocal = current;
    retainNewest(retainedLocal);
    return retainedLocal;
  }

  return async function readUsageLimits() {
    const localUsage = local();
    // Keep model-specific windows current on the existing shared API cooldown.
    // A fresh local pair can be served immediately while that request is pending.
    const remoteRead = remote.get();
    const completedRemote = remote.peek();
    if (completedRemote) acceptRemote(completedRemote);
    if (localUsage && freshness(localUsage, true) === "fresh") {
      void remoteRead.then(acceptRemote).catch(() => {});
      const selected = newestSuccessful;
      return withRetainedLimits(selected ? {
        ...selected,
        freshness: freshness(selected, selected.origin === "local_observation"),
        attemptedAt: latestRemote?.attemptedAt ?? null,
        failureKind: latestRemote?.failureKind ?? null,
        retryAt: latestRemote?.retryAt ?? null,
        error: latestRemote?.error || "",
      } : localUsage);
    }

    const remoteUsage = await remoteRead;
    const remoteCandidate = acceptRemote(remoteUsage);
    const selected = newestSuccessful;
    if (selected) {
      const output = { ...selected, freshness: freshness(selected, selected.origin === "local_observation") };
      if (remoteCandidate) return withRetainedLimits(output);
      return withRetainedLimits({
        ...output,
        attemptedAt: remoteUsage.attemptedAt || output.attemptedAt,
        failureKind: remoteUsage.failureKind ?? null,
        retryAt: remoteUsage.retryAt ?? null,
        error: remoteUsage.error || "",
      });
    }
    return { ...remoteUsage, origin: "provider_api", freshness: "stale" };
  };
}
