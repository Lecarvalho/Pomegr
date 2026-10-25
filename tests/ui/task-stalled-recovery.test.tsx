import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaskReviewPanel } from "../../app/components/tasks/TaskReviewPanel";
import type { Task, TaskBoard } from "../../shared/task-contract";
import { resolveTaskCheckFacts, resolveTaskSessionFacts } from "../../server/runtime/task-session-lookup.mjs";
import { createTaskStallWatcher, END_CONFIRM_DELAY_MS } from "../../server/tasks/task-stall.mjs";
import { openTaskStore } from "../../server/tasks/task-store.mjs";
import { passingGates } from "../server/tasks/queue-test-support.mjs";

it("Pokrr T-3 shape: an ended session leaves dirty work and no report, then the owner sees Stalled with a reason", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-t3-stalled-"));
  const repositoryId = `repo-${"a1".repeat(12)}`;
  const sessionId = "codex:019a0000-2222-7333-8444-555566667777";
  let now = Date.parse("2026-10-25T12:00:00Z");
  let state = "working";
  const committed = {
    session: { repository: { available: true, branch: "tasks/T-3", readAt: new Date(now).toISOString(),
      files: [] as { status: string; path: string }[] } },
    agents: [{ id: "primary", liveness: { reason: "writer_present" } }],
  };
  const observation = {
    observationStore: { get: () => ({ publicState: committed }) },
    catalogSessions: () => [{ id: sessionId, activityStatus: state }],
  };
  const facts = (id: string) => resolveTaskSessionFacts(id, observation);
  const storeOptions = { directory, now: () => now };
  let store = openTaskStore(storeOptions);
  vi.useFakeTimers();
  const watcher = createTaskStallWatcher({ taskStore: store, resolveSessionFacts: facts,
    subscribe: () => () => {} });
  try {
    for (let number = 1; number <= 3; number += 1) {
      expect(store.apply(repositoryId, "create", { text: `Synthetic task ${number}`,
        completeWhen: { checks: ["tree_clean"], own: null } }).ok).toBe(true);
    }
    const planned = store.planStart(repositoryId, { id: "T-3" },
      // The JavaScript signature infers null for this injectable resolver.
      // @ts-expect-error passingGates is the existing Node fixture's start-gate resolver.
      () => ({ root: directory, pluginReady: true }), passingGates);
    expect(planned.ok).toBe(true);
    expect(store.bindSession({ token: planned.plan.token, sessionId })).toEqual({ ok: true });
    const task = () => (store.readBoard(repositoryId) as TaskBoard).tasks.find((item) => item.id === "T-3") as Task;
    expect(task().session?.id).toBe(sessionId);
    expect(task().report).toBeNull();
    committed.session.repository.files.push({ status: "modified", path: "src/example.ts" });
    expect(resolveTaskCheckFacts(sessionId, observation).treeClean).toBe(false);
    watcher.sweep();
    expect(task().state).toBe("not_queued");

    state = "stopped";
    committed.agents[0].liveness.reason = "writer_released";
    watcher.sweep();
    expect(task().state).toBe("not_queued");
    now += END_CONFIRM_DELAY_MS - 1;
    vi.advanceTimersByTime(END_CONFIRM_DELAY_MS - 1);
    watcher.sweep();
    expect(task().state).toBe("not_queued");
    // A quiet catalog still confirms the end through the watcher's own timer.
    now += 51;
    vi.advanceTimersByTime(51);
    expect(task().state).toBe("stalled");
    expect(task().report).toBeNull();
    expect(resolveTaskCheckFacts(sessionId, observation).treeClean).toBe(false);
    watcher.stop();

    store.close();
    store = openTaskStore(storeOptions);
    expect(task().state).toBe("stalled");
    expect(task().session?.id).toBe(sessionId);
    expect(task().report).toBeNull();
    expect(store.readHome()?.attention).toEqual([
      { repositoryId, taskId: "T-3", title: "Synthetic task 3", state: "stalled" },
    ]);
    render(<TaskReviewPanel task={task()} />);
    expect(screen.getByRole("heading", { name: "Stalled" })).toBeVisible();
    expect(screen.getByText("The session ended with no report.")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Complete when" })).not.toBeInTheDocument();
  } finally {
    watcher.stop();
    vi.useRealTimers();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
