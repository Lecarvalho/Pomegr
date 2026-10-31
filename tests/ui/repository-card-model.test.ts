import { describe, expect, it } from "vitest";
import type { RepositoryProviderInventory, RepositorySummary } from "../../shared/monitor-contract";
import type { RepositoryPluginSetup } from "../../shared/repository-plugin-contract";
import { repositorySetupSummary } from "../../app/components/repositories/repository-setup";
import {
  ACTIVITY_DAYS, BAR_MAX_PX, BAR_MIN_PX, BAR_STUB_PX, TILE_TINTS, activityBars, activityLabel, providerMarks, repositoryActivityLine, repositoryInitial, repositoryNeedsAttention, repositorySetupCard, repositorySetupHref, tileTint,
} from "../../app/components/repositories/repository-card-model";

const checkedAt = "2026-09-04T10:00:00.000Z";
const plugin = (overrides: Partial<RepositoryPluginSetup> = {}): RepositoryPluginSetup => ({
  readiness: "ready", installation: "installed", version: "0.5.0", enabled: true, scope: "user", checkedAt, update: { status: "current", version: null, checkedAt }, canInstall: false, canUpdate: false, ...overrides,
});
const provider = (overrides: Partial<RepositoryProviderInventory> = {}): RepositoryProviderInventory => ({
  provider: "claude", source: "Claude Code", sessionCount: 1, supported: true, status: "current", failureKind: null, currentRevision: null, revisions: [], pluginSetup: plugin(), ...overrides,
});
const repository = (overrides: Partial<RepositorySummary> = {}): RepositorySummary => ({
  id: "repo-0123456789abcdef01234567", name: "pomegr", displayName: "Pomegr", sessionCount: 3, liveCount: 0, historyCount: 3, providerCount: 1, updatedAt: checkedAt,
  providers: [provider()], reporting: { status: "configured", version: 1, checkedAt }, ...overrides,
});

describe("the setup badge", () => {
  // Every summary the list can reach, with the badge it is drawn as and the fix it asks for.
  it.each([
    ["ready", repository(), "Ready", "positive", null],
    ["a plugin update", repository({ providers: [provider({ pluginSetup: plugin({ canUpdate: true, update: { status: "available", version: "0.6.0", checkedAt } }) })] }), "Ready", "positive", "plugin"],
    ["setup being checked", repository({ providers: [provider({ pluginSetup: plugin({ readiness: "loading" }) })] }), "Setup unverified", "neutral", null],
    ["setup not confirmed", repository({ reporting: undefined }), "Setup unverified", "neutral", "plugin"],
    ["a plugin that is not installed", repository({ providers: [provider({ pluginSetup: plugin({ installation: "not_installed", version: null, enabled: null }) })] }), "Reporting off", "warning", "plugin"],
    ["a plugin that is disabled", repository({ providers: [provider({ pluginSetup: plugin({ enabled: false }) })] }), "Reporting off", "warning", "plugin"],
    ["a reporting policy that is invalid", repository({ reporting: { status: "invalid", version: null, checkedAt } }), "Reporting off", "warning", "reporting"],
    ["a reporting policy that is missing", repository({ reporting: { status: "missing", version: null, checkedAt } }), "Reporting off", "warning", "reporting"],
  ] as const)("maps %s", (_name, input, badge, tone, tab) => {
    const card = repositorySetupCard(input);
    expect(card.badge).toBe(badge);
    expect(card.tone).toBe(tone);
    expect(card.fix?.tab ?? null).toBe(tab);
    // The card is named with today's summary, which keeps the detail the badge folds away.
    expect(card.summary).toBe(repositorySetupSummary(input).label);
  });

  it("asks for nothing while setup is being checked, so a fix line never appears and goes", () => {
    expect(repositorySetupCard(repository({ providers: [provider({ pluginSetup: plugin({ readiness: "loading" }) })] })).fix).toBeNull();
  });

  it("words each fix in a sentence and links it to the tab where it is done", () => {
    const off = repositorySetupCard(repository({ reporting: { status: "missing", version: null, checkedAt } }));
    expect(off.fix?.text).toBe("Agents here do not report their state to Pomegr.");
    expect(repositorySetupHref("repo-0123456789abcdef01234567", off.fix!)).toBe("/repositories/repo-0123456789abcdef01234567?tab=reporting");
    const unverified = repositorySetupCard(repository({ reporting: undefined }));
    expect(unverified.fix?.text).toBe("Pomegr has not confirmed its plugin here yet.");
    expect(repositorySetupHref("repo-0123456789abcdef01234567", unverified.fix!)).toBe("/repositories/repo-0123456789abcdef01234567?tab=plugin");
  });

  // One fixture for every summary the list can reach, with whether its card shows a fix line.
  const everySetup: readonly [string, RepositorySummary, boolean][] = [
    ["ready", repository(), false],
    ["a plugin update", repository({ providers: [provider({ pluginSetup: plugin({ canUpdate: true, update: { status: "available", version: "0.6.0", checkedAt } }) })] }), true],
    ["setup being checked", repository({ providers: [provider({ pluginSetup: plugin({ readiness: "loading" }) })] }), false],
    ["setup not confirmed", repository({ reporting: undefined }), true],
    ["a plugin that is not installed", repository({ providers: [provider({ pluginSetup: plugin({ installation: "not_installed", version: null, enabled: null }) })] }), true],
    ["a plugin that is disabled", repository({ providers: [provider({ pluginSetup: plugin({ enabled: false }) })] }), true],
    ["a reporting policy that is invalid", repository({ reporting: { status: "invalid", version: null, checkedAt } }), true],
    ["a reporting policy that is missing", repository({ reporting: { status: "missing", version: null, checkedAt } }), true],
  ];

  it.each(everySetup)("needs attention exactly when the card shows a fix line: %s", (_name, input, hasFix) => {
    expect(repositorySetupCard(input).fix !== null).toBe(hasFix);
    expect(repositoryNeedsAttention(input)).toBe(hasFix);
  });

  it("lists under Needs attention the set of cards that show a fix line, and no other", () => {
    const withFix = everySetup.filter(([, input]) => repositorySetupCard(input).fix !== null).map(([name]) => name);
    expect(everySetup.filter(([, input]) => repositoryNeedsAttention(input)).map(([name]) => name)).toEqual(withFix);
    // Ready and Checking setup are the only two that ask nothing of the owner.
    expect(everySetup.filter(([, input]) => !repositoryNeedsAttention(input)).map(([name]) => name)).toEqual(["ready", "setup being checked"]);
  });
});

describe("the activity line", () => {
  it("counts the sessions that run now, and otherwise says when the repository was last active", () => {
    expect(repositoryActivityLine(repository({ liveCount: 2, updatedAt: new Date().toISOString() }))).toBe("2 running now · active just now");
    expect(repositoryActivityLine(repository({ liveCount: 0, updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }))).toBe("last active 3h ago");
    expect(repositoryActivityLine(repository({ liveCount: 1, updatedAt: null }))).toBe("1 running now");
    expect(repositoryActivityLine(repository({ liveCount: 0, updatedAt: null }))).toBe("No activity time known");
  });
});

describe("fourteen days of sessions", () => {
  const days = [3, 5, 2, 0, 4, 6, 7, 3, 5, 8, 6, 4, 9, 7];

  it("draws one bar for each day, the busiest day at full height and a day with no session as a stub", () => {
    const bars = activityBars(days, false)!;
    expect(bars).toHaveLength(ACTIVITY_DAYS);
    expect(bars.map((bar) => bar.count)).toEqual(days);
    expect(Math.max(...bars.map((bar) => bar.height))).toBe(BAR_MAX_PX);
    expect(bars[3].height).toBe(BAR_STUB_PX);
    expect(bars[12].height).toBe(BAR_MAX_PX);
    expect(bars[2].height).toBe(Math.round((2 / 9) * BAR_MAX_PX));
  });

  it("never draws a day with a session under the minimum, however busy another day was", () => {
    const bars = activityBars([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100], false)!;
    expect(bars[0].height).toBe(BAR_MIN_PX);
    expect(bars[13].height).toBe(BAR_MAX_PX);
  });

  it("marks the last day as live only while a session runs and that day has one", () => {
    expect(activityBars(days, true)!.map((bar) => bar.live)).toEqual([...Array(13).fill(false), true]);
    expect(activityBars(days, false)!.some((bar) => bar.live)).toBe(false);
    expect(activityBars([...days.slice(0, 13), 0], true)!.some((bar) => bar.live)).toBe(false);
  });

  it("draws only stubs for a repository with no session in 14 days", () => {
    expect(activityBars(Array(14).fill(0), false)!.map((bar) => bar.height)).toEqual(Array(14).fill(BAR_STUB_PX));
  });

  it.each([[undefined], [null], [[]], [[1, 2, 3]], [Array(15).fill(1)], [[...Array(13).fill(1), -1]], [[...Array(13).fill(1), 1.5]], [[...Array(13).fill(1), "1"]], ["not a list"]])("draws no bars for %j, which is no series", (series) => {
    expect(activityBars(series, true)).toBeNull();
  });

  it("words the bars for assistive technology, the oldest day first", () => {
    expect(activityLabel(activityBars(days, false)!)).toBe("69 sessions started in the last 14 days, one count for each day, oldest first: 3, 5, 2, 0, 4, 6, 7, 3, 5, 8, 6, 4, 9, 7");
    expect(activityLabel(activityBars([...Array(13).fill(0), 1], false)!)).toMatch(/^1 session started/);
  });
});

describe("providers and the tile", () => {
  it("marks a provider that has a session here with its letter and its name", () => {
    expect(providerMarks(repository({ providers: [provider(), provider({ provider: "codex", source: "Codex" })] }))).toEqual([
      { provider: "claude", letter: "C", name: "Claude Code" }, { provider: "codex", letter: "X", name: "Codex" },
    ]);
    expect(providerMarks(repository({ providers: [provider({ sessionCount: 0 }), provider({ provider: "codex", source: "Codex" })] })).map((mark) => mark.name)).toEqual(["Codex"]);
  });

  it("tints a tile from the repository's identity, so the tint is stable", () => {
    const tint = tileTint("repo-0123456789abcdef01234567");
    expect(tileTint("repo-0123456789abcdef01234567")).toBe(tint);
    expect(tint).toBeGreaterThanOrEqual(0);
    expect(tint).toBeLessThan(TILE_TINTS);
    expect(new Set(["a", "b", "c", "d", "e", "f", "0", "1", "2", "3"].map((letter) => tileTint(`repo-${letter.repeat(24)}`))).size).toBeGreaterThan(1);
  });

  it("takes the first letter of the name, in capitals", () => {
    expect(repositoryInitial("clapline")).toBe("C");
    expect(repositoryInitial("  frontend ")).toBe("F");
    expect(repositoryInitial("")).toBe("?");
  });
});
