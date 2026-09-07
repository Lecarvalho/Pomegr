import { describe, expect, it } from "vitest";

import { repositoryLastActivity, repositorySetupSummary } from "../../app/components/repositories/repository-setup";
import { relativeTime } from "../../app/dashboard-utils";
import type { RepositoryPluginSetup } from "../../shared/repository-plugin-contract";
import type { RepositoryProviderInventory, RepositorySummary } from "../../shared/monitor-contract";

const checkedAt = "2026-09-04T10:00:00.000Z";

function pluginSetup(overrides: Partial<RepositoryPluginSetup> = {}): RepositoryPluginSetup {
  return {
    readiness: "ready",
    installation: "installed",
    version: "0.5.0",
    enabled: true,
    scope: "user",
    checkedAt,
    update: { status: "current", version: null, checkedAt },
    canInstall: false,
    canUpdate: false,
    ...overrides,
  };
}

function provider(overrides: Partial<RepositoryProviderInventory> = {}): RepositoryProviderInventory {
  return {
    provider: "claude",
    source: "Claude Code",
    sessionCount: 1,
    supported: true,
    status: "current",
    failureKind: null,
    currentRevision: null,
    revisions: [],
    pluginSetup: pluginSetup(),
    ...overrides,
  };
}

function repository(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    id: "repo-0123456789abcdef01234567",
    name: "pomegr",
    displayName: "Pomegr",
    sessionCount: 1,
    liveCount: 0,
    historyCount: 1,
    providerCount: 1,
    updatedAt: checkedAt,
    providers: [provider()],
    reporting: { status: "configured", version: 1, checkedAt },
    ...overrides,
  };
}

function summary(repositoryValue: RepositorySummary) {
  return repositorySetupSummary(repositoryValue);
}

describe("repositorySetupSummary", () => {
  it.each([
    ["loading", repository({ providers: [provider({ pluginSetup: pluginSetup({ readiness: "loading" }) })] }), { label: "Checking setup", tone: "neutral" }],
    ["update available", repository({ providers: [provider({ pluginSetup: pluginSetup({ canUpdate: true, update: { status: "available", version: "0.6.0", checkedAt } }) })] }), { label: "Plugin update available", tone: "warning" }],
    ["active provider not installed", repository({ providers: [provider({ pluginSetup: pluginSetup({ installation: "not_installed", version: null, enabled: null }) })] }), { label: "Plugin not installed", tone: "warning" }],
    ["disabled", repository({ providers: [provider({ pluginSetup: pluginSetup({ enabled: false }) })] }), { label: "Plugin disabled", tone: "warning" }],
    ["invalid reporting", repository({ reporting: { status: "invalid", version: null, checkedAt } }), { label: "Reporting invalid", tone: "warning" }],
    ["missing reporting", repository({ reporting: { status: "missing", version: null, checkedAt } }), { label: "Reporting not configured", tone: "neutral" }],
    ["missing reporting object", repository({ reporting: undefined }), { label: "Setup unverified", tone: "neutral" }],
    ["plugin missing", repository({ providers: [provider({ pluginSetup: undefined })] }), { label: "Setup unverified", tone: "neutral" }],
    ["plugin unavailable", repository({ providers: [provider({ pluginSetup: pluginSetup({ readiness: "unavailable" }) })] }), { label: "Setup unverified", tone: "neutral" }],
    ["plugin installation unknown", repository({ providers: [provider({ pluginSetup: pluginSetup({ installation: "unknown", version: null, enabled: null }) })] }), { label: "Setup unverified", tone: "neutral" }],
    ["reporting unknown", repository({ reporting: { status: "unknown", version: null, checkedAt } }), { label: "Setup unverified", tone: "neutral" }],
    ["ready", repository(), { label: "Ready", tone: "positive" }],
  ] as const)("returns the decision-4 result for %s", (_name, input, expected) => {
    expect(summary(input)).toEqual(expected);
  });

  it("does not warn for an unobserved provider whose plugin is not installed", () => {
    const unobserved = provider({ sessionCount: 0, pluginSetup: pluginSetup({ installation: "not_installed", version: null, enabled: null }) });

    expect(summary(repository({ sessionCount: 0, historyCount: 0, providerCount: 1, providers: [unobserved] }))).toEqual({
      label: "Ready",
      tone: "positive",
    });
  });

  it("uses the highest-priority condition across providers", () => {
    const update = provider({ provider: "codex", source: "Codex", pluginSetup: pluginSetup({ canUpdate: true, update: { status: "available", version: "0.6.0", checkedAt } }) });
    const loading = provider({ pluginSetup: pluginSetup({ readiness: "loading", canUpdate: true }) });

    expect(summary(repository({ providers: [update, loading], providerCount: 2 }))).toEqual({
      label: "Checking setup",
      tone: "neutral",
    });
  });

  it("requires an observed session before a not-installed provider needs attention", () => {
    const unobserved = provider({ sessionCount: 0, pluginSetup: pluginSetup({ installation: "not_installed", version: null, enabled: null }) });
    const observed = provider({ provider: "codex", source: "Codex", sessionCount: 1, pluginSetup: pluginSetup({ installation: "not_installed", version: null, enabled: null }) });

    expect(summary(repository({ providers: [unobserved, observed], providerCount: 2 }))).toEqual({
      label: "Plugin not installed",
      tone: "warning",
    });
  });

  it.each([
    ["update over missing installation", repository({
      providers: [provider({ pluginSetup: pluginSetup({ installation: "not_installed", version: null, enabled: null, canUpdate: true, update: { status: "available", version: "0.6.0", checkedAt } }) })],
    }), "Plugin update available"],
    ["missing installation over disabled", repository({ providers: [provider({ pluginSetup: pluginSetup({ installation: "not_installed", version: null, enabled: false }) })] }), "Plugin not installed"],
    ["disabled over invalid reporting", repository({ providers: [provider({ pluginSetup: pluginSetup({ enabled: false }) })], reporting: { status: "invalid", version: null, checkedAt } }), "Plugin disabled"],
    ["invalid reporting over unavailable plugin", repository({ providers: [provider({ pluginSetup: pluginSetup({ readiness: "unavailable" }) })], reporting: { status: "invalid", version: null, checkedAt } }), "Reporting invalid"],
    ["missing reporting over unavailable plugin", repository({ providers: [provider({ pluginSetup: pluginSetup({ readiness: "unavailable" }) })], reporting: { status: "missing", version: null, checkedAt } }), "Reporting not configured"],
  ] as const)("applies precedence: %s", (_name, input, label) => {
    expect(summary(input).label).toBe(label);
  });
});

describe("repositoryLastActivity", () => {
  it("uses an em dash when the repository has no activity timestamp", () => {
    expect(repositoryLastActivity(repository({ updatedAt: null }))).toBe("—");
  });

  it("formats a known activity timestamp with the shared relative-time formatter", () => {
    const knownTimestamp = "2026-09-07T12:00:00.000Z";
    const input = repository({ updatedAt: knownTimestamp });

    expect(repositoryLastActivity(input)).toBe(relativeTime(knownTimestamp));
  });
});
