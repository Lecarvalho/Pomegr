import { describe, expect, it } from "vitest";
import { parseTaskBoard } from "../../app/tasks-store";

const repositoryId = "repo-0123456789abcdef01234567";
const settings = {
  actions: { start: true, review: true, sendBack: false, merge: false, writeTasks: false, markDone: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: 2, tasks: 2, tasksAtATime: 1, sendBacks: null, usagePercent: 80 },
  workRules: [{ kind: "tag", value: "pilot" }, { kind: "tasks", value: ["T-1", "T-2"] }],
  reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false, followUps: true, settledAt: "2026-10-25T10:00:00.000Z",
};
const memory = { text: "- Run focused tests first.", previous: "- Run tests.", updatedAt: 2, updatedBy: "aril" };
const grant = { startedAt: 1, endsAt: 2, startsUsed: 0, actions: settings.actions, limits: settings.limits, active: false, endedAt: 2, endReason: "stopped" };
const body = (aril: unknown) => ({ version: 1, readiness: "ready", repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, order: [] }, aril });

describe("parseTaskBoard Aril settings", () => {
  it("keeps the served settings, memory, and grant", () => {
    expect(parseTaskBoard(body({ settings, memory, grant }), repositoryId)?.aril).toEqual({ settings, memory, grant });
    expect(parseTaskBoard(body({ settings, memory, grant: null }), repositoryId)?.aril?.grant).toBeNull();
  });

  it("leaves Aril out when any part is malformed, and keeps the board", () => {
    for (const broken of [undefined, { settings, memory: "x" }, { settings, memory: [] }, { settings, memory: { ...memory, text: "x".repeat(6001) } }, { settings, memory: { ...memory, previous: 5 } },
      { settings, memory: { ...memory, updatedBy: "someone" } }, { settings, memory: { ...memory, updatedAt: "now" } }, { settings, memory: { text: "- a" } }, { settings: { ...settings, mergeMode: "fast" }, memory }, { settings: { ...settings, followUps: "on" }, memory },
      { settings: Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "followUps")), memory },
      { settings: { ...settings, limits: { ...settings.limits, tasks: "2" } }, memory }, { settings, memory, grant: { ...grant, endReason: "other" } }]) {
      const board = parseTaskBoard(body(broken), repositoryId);
      expect(board).not.toBeNull();
      expect(board?.aril).toBeUndefined();
    }
  });

  it("keeps a memory that was never written, with no time and no author", () => {
    const empty = { text: "", previous: null, updatedAt: null, updatedBy: null };
    expect(parseTaskBoard(body({ settings, memory: empty, grant: null }), repositoryId)?.aril?.memory).toEqual(empty);
  });

  it("keeps a Mark done switch in settings and the grant, and needs it as a boolean (T-182)", () => {
    const actions = { ...settings.actions, markDone: true };
    expect(parseTaskBoard(body({ settings: { ...settings, actions }, memory, grant: { ...grant, actions } }), repositoryId)?.aril?.grant?.actions.markDone).toBe(true);
    const older = Object.fromEntries(Object.entries(settings.actions).filter(([key]) => key !== "markDone"));
    for (const broken of [{ settings: { ...settings, actions: older }, memory }, { settings: { ...settings, actions: { ...settings.actions, markDone: "yes" } }, memory },
      { settings, memory, grant: { ...grant, actions: older } }]) expect(parseTaskBoard(body(broken), repositoryId)?.aril).toBeUndefined();
  });
});
