import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ArilGrant, ArilSettings } from "../../shared/task-contract";
import { BOARD_RUNNING } from "../../app/components/design-system/DesignSystemTaskSampleData";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { arilSettingsHref } from "../../app/components/tasks/CapacityStrip";
import { timeOfDay } from "../../app/components/tasks/task-schedule";

const settings: ArilSettings = {
  actions: { start: true, review: true, sendBack: false, merge: false, writeTasks: false, markDone: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: 2, tasks: 5, tasksAtATime: 2, sendBacks: null, usagePercent: 80 },
  workRules: [{ kind: "tag", value: "backend" }], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false, followUps: true,
};

describe("the Aril settings link on the Tasks page", () => {
  it("is a quiet link to the board's repository in Settings, before Log, with no dialog behind it", () => {
    render(<TaskBoardView board={{ ...BOARD_RUNNING, aril: { settings, memory: [] } }} readTaskLog={async () => ({ ok: false })} />);
    const link = screen.getByRole("link", { name: "Aril settings" });
    expect(link).toHaveAttribute("href", `/settings?section=aril&repository=${BOARD_RUNNING.repositoryId}`);
    expect(arilSettingsHref(BOARD_RUNNING.repositoryId)).toBe(link.getAttribute("href"));
    expect(link).toHaveClass("commandQuietAction", "taskQueueSettingsAction");
    expect(link).not.toHaveAttribute("aria-haspopup");
    expect(link.nextElementSibling).toHaveTextContent("Log");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("follows the active-grant caption, which has no button behavior", () => {
    const endsAt = Date.parse("2026-10-30T18:30:00Z");
    const grant: ArilGrant = { active: true, startedAt: endsAt - 7_200_000, endsAt, startsUsed: 2, actions: settings.actions, limits: settings.limits };
    render(<TaskBoardView board={{ ...BOARD_RUNNING, aril: { settings, memory: [], grant } }} />);
    const strip = screen.getByRole("region", { name: "Provider capacity" });
    const link = within(strip).getByRole("link", { name: "Aril settings" });
    expect(link.previousElementSibling).toHaveTextContent(`Aril grant until ${timeOfDay(new Date(endsAt).toISOString())}`);
    expect(link.previousElementSibling?.tagName).toBe("SPAN");
  });
});
