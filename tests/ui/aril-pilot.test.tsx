import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/task-contract";
import type { ArilPilot } from "../../shared/aril-pilot-contract";
import { ArilPilotControl } from "../../app/components/tasks/ArilPilotControl";

const repositoryId = "repo-0123456789abcdef01234567";
const task: Task = {
  id: "T-1", text: "Finish the existing task", columnId: "col-1", position: 0, featureId: null, group: null,
  run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null }, state: "not_queued", scheduledAt: null,
  session: null, source: null, report: null, createdAt: "2026-10-18T12:00:00.000Z", updatedAt: "2026-10-18T12:00:00.000Z",
};
const pilot: ArilPilot = {
  id: "pilot-1", revision: 1, repositoryId, goal: "Finish the task", taskIds: ["T-1"], expiresAt: "2026-10-19T12:00:00.000Z", status: "active",
  roundLimit: 20, startLimit: 3, concurrency: 1, minIntervalMinutes: 5,
  allowedRuns: [{ provider: "claude", model: null }], inference: { provider: "codex", model: "gpt-5-codex" }, roundsUsed: 1, startsUsed: 1,
  nextWakeAt: null, waiting: "Waiting for session evidence", receipts: [{ at: "2026-10-18T12:02:00.000Z", taskId: "T-1", action: "start", status: "started", provider: "claude", model: "sonnet", reason: "Task is selected and ready.", evidenceRevision: "rev-8" }], summary: null,
};
const arilPilot = vi.fn();

function setBridge() {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { arilPilot };
}

afterEach(() => {
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Aril pilot on a repository board", () => {
  it("requires task selection and a grant review before activation, then displays the saved status", async () => {
    const user = userEvent.setup();
    arilPilot.mockImplementation(async (operation: string) => operation === "read" ? { ok: true, pilot: null, history: [] } : { ok: true, pilot });
    setBridge();
    render(<ArilPilotControl repositoryId={repositoryId} tasks={[task]} desktop />);

    await screen.findByRole("button", { name: "Aril pilot" });
    await user.click(screen.getByRole("button", { name: "Aril pilot" }));
    await user.type(screen.getByLabelText("Goal"), "Finish the task");
    await user.click(screen.getByRole("button", { name: "Add allowed pair" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "claude");
    await user.selectOptions(screen.getByLabelText("Inference provider"), "codex");
    await user.type(screen.getByLabelText("Inference model"), "gpt-5-codex");
    expect(screen.getByRole("button", { name: "Review grant" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /T-1 Finish the existing task/ }));
    await user.click(screen.getByRole("button", { name: "Review grant" }));

    expect(screen.getByText("Start a new session for a selected task, or fill an unset task run configuration.")).toBeInTheDocument();
    expect(screen.getByText("Claude Code · Default model")).toBeInTheDocument();
    expect(screen.getByText("Codex · gpt-5-codex")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm and activate pilot" }));

    await waitFor(() => expect(arilPilot).toHaveBeenCalledWith("activate", expect.objectContaining({
      repositoryId, goal: "Finish the task", taskIds: ["T-1"], durationHours: 24, roundLimit: 20, startLimit: 3,
      concurrency: 1, minIntervalMinutes: 5, allowedRuns: [{ provider: "claude", model: null }],
      inference: { provider: "codex", model: "gpt-5-codex" },
    })));
    const status = await screen.findByRole("region", { name: "Aril pilot status" });
    expect(within(status).getByText(/Aril pilot · active/)).toBeInTheDocument();
    expect(within(status).getByText("Waiting for session evidence")).toBeInTheDocument();
    expect(within(status).getByText("Task is selected and ready.")).toBeInTheDocument();
    expect(within(status).getByText(/Evidence rev-8/)).toBeInTheDocument();
    expect(within(status).getByText(/Rounds 1\/20 · Starts 1\/3/)).toBeInTheDocument();
  });

  it("shows prior grant summaries in a collapsed history disclosure", async () => {
    const oldGrant = { ...pilot, id: "pilot-old", status: "finished" as const, summary: "Task completed." };
    arilPilot.mockResolvedValue({ ok: true, pilot: null, history: [oldGrant] });
    setBridge();
    render(<ArilPilotControl repositoryId={repositoryId} tasks={[task]} desktop />);

    const disclosure = await screen.findByText("Previous grants (1)");
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(disclosure);
    expect(screen.getByText("Task completed.")).toBeInTheDocument();
  });

  it("keeps activation failures visible on the review step", async () => {
    const user = userEvent.setup();
    arilPilot.mockImplementation(async (operation: string) => operation === "read" ? { ok: true, pilot: null } : { ok: false, error: "conflict" });
    setBridge();
    render(<ArilPilotControl repositoryId={repositoryId} tasks={[task]} desktop />);
    await user.click(await screen.findByRole("button", { name: "Aril pilot" }));
    await user.type(screen.getByLabelText("Goal"), "Finish the task");
    await user.click(screen.getByRole("button", { name: "Add allowed pair" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "claude");
    await user.selectOptions(screen.getByLabelText("Inference provider"), "codex");
    await user.click(screen.getByRole("checkbox", { name: /T-1 Finish the existing task/ }));
    await user.click(screen.getByRole("button", { name: "Review grant" }));
    await user.click(screen.getByRole("button", { name: "Confirm and activate pilot" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A pilot changed before this grant could be activated.");
  });

  it("confirms pause and updates the persisted pilot status", async () => {
    const user = userEvent.setup();
    const paused = { ...pilot, status: "paused" as const };
    vi.stubGlobal("confirm", vi.fn(() => true));
    arilPilot.mockImplementation(async (operation: string) => operation === "read" ? { ok: true, pilot } : { ok: true, pilot: paused });
    setBridge();
    render(<ArilPilotControl repositoryId={repositoryId} tasks={[task]} desktop />);
    const status = await screen.findByRole("region", { name: "Aril pilot status" });
    await user.click(within(status).getByRole("button", { name: "Pause" }));
    expect(arilPilot).toHaveBeenCalledWith("pause", { repositoryId });
    expect(await within(status).findByText(/Aril pilot · paused/)).toBeInTheDocument();
  });

  it("requires an owner check before requeueing an uncertain start and revoking its grant", async () => {
    const user = userEvent.setup();
    const needsYou: ArilPilot = { ...pilot, status: "needs_you", receipts: [{ ...pilot.receipts[0], status: "uncertain" }] };
    const revoked: ArilPilot = { ...needsYou, status: "revoked" };
    const confirm = vi.fn(() => true);
    const onReconcile = vi.fn(async () => true);
    vi.stubGlobal("confirm", confirm);
    arilPilot.mockImplementation(async (operation: string) => operation === "read"
      ? { ok: true, pilot: needsYou, history: [] }
      : { ok: true, pilot: revoked, history: [] });
    setBridge();
    render(<ArilPilotControl repositoryId={repositoryId} tasks={[task]} desktop onReconcile={onReconcile} />);

    await user.click(await screen.findByRole("button", { name: "Reconcile T-1" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Only continue after checking that no session started for T-1."));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Any existing session will continue running; Pomegr will not stop it."));
    expect(onReconcile).toHaveBeenCalledWith("T-1");
    expect(arilPilot).toHaveBeenCalledWith("revoke", { repositoryId });
    expect(arilPilot).not.toHaveBeenCalledWith("activate", expect.anything());
    expect(await screen.findByText(/Aril pilot · revoked/)).toBeInTheDocument();
  });

  it("does not reconcile when the owner declines or the selected task is no longer present", async () => {
    const user = userEvent.setup();
    const needsYou: ArilPilot = { ...pilot, status: "needs_you", receipts: [{ ...pilot.receipts[0], status: "uncertain" }] };
    const onReconcile = vi.fn(async () => true);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    arilPilot.mockResolvedValue({ ok: true, pilot: needsYou, history: [] });
    setBridge();
    const { rerender } = render(<ArilPilotControl repositoryId={repositoryId} tasks={[task]} desktop onReconcile={onReconcile} />);

    await user.click(await screen.findByRole("button", { name: "Reconcile T-1" }));
    expect(onReconcile).not.toHaveBeenCalled();
    expect(arilPilot).not.toHaveBeenCalledWith("revoke", { repositoryId });

    rerender(<ArilPilotControl repositoryId={repositoryId} tasks={[]} desktop onReconcile={onReconcile} />);
    expect(screen.queryByRole("button", { name: "Reconcile T-1" })).not.toBeInTheDocument();
  });

  it("explicitly marks paired and browser use unavailable", () => {
    render(<ArilPilotControl repositoryId={repositoryId} tasks={[task]} desktop={false} />);
    expect(screen.getByText("Aril pilot is available in the Pomegr desktop app only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aril pilot" })).not.toBeInTheDocument();
  });
});
