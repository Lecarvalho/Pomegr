import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../../app/live-events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fake = vi.hoisted(() => ({
  write: vi.fn(), dispose: vi.fn(), focus: vi.fn(), fit: vi.fn(), resize: null as (() => void) | null,
  data: null as ((value: string) => void) | null,
  output: null as ((value: unknown) => void) | null,
  revision: null as ((value: LiveEvent) => void) | null,
  terminal: vi.fn(), replace: vi.fn(),
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; options = {};
  open = vi.fn(); loadAddon = vi.fn(); write = fake.write; dispose = fake.dispose; focus = fake.focus;
  onData(callback: (value: string) => void) { fake.data = callback; return { dispose: vi.fn() }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = fake.fit; } }));
vi.mock("../../app/live-events", () => ({ subscribeLiveEvents: (callback: (value: LiveEvent) => void) => { fake.revision = callback; return () => {}; } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: fake.replace }), useSearchParams: () => new URLSearchParams(window.location.search) }));

import { ManagedTerminalPanel } from "../../app/components/dashboard/session-terminal/ManagedTerminalPanel";
import { SessionTerminalPanel } from "../../app/components/dashboard/session-terminal/SessionTerminalPanel";
import { TaskTerminalBoundary, TaskTerminalHint } from "../../app/components/tasks/TaskTerminalBoundary";
import { startDesktopTask } from "../../app/components/tasks/task-desktop";
import { SessionTerminalSection } from "../../app/components/design-system/DesignSystemTerminalSample";

const entry = { key: "terminal-one", repositoryId: "repo-one", taskId: "T-1", sessionId: "codex:one", state: "live" as const };
const read = vi.fn(async () => ({ ok: true, page: { messages: [], cursor: null, older: null, status: "ok", reset: false } }));
function install() {
  Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: {
    terminal: fake.terminal, sessionHistory: read, taskStart: vi.fn(async () => ({ status: "started" })),
    onTerminalOutput(callback: typeof fake.output) { fake.output = callback; return () => { fake.output = null; }; },
  } });
}
function emit(event: string, fields = {}) {
  const attachId = fake.terminal.mock.calls.find(([op]) => op === "attach")?.[1].attachId;
  act(() => fake.output?.({ attachId, event, ...fields }));
}
beforeEach(() => {
  vi.clearAllMocks(); install();
  fake.write.mockImplementation((_value, done) => done?.());
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { fake.resize = callback; } observe = vi.fn(); disconnect = vi.fn(); });
  fake.terminal.mockImplementation(async (op, payload) => {
    if (op === "list") return { ok: true, status: "ready", sessions: [entry], hosts: [] };
    if (op === "attach") { fake.output?.({ attachId: payload.attachId, event: "output", data: "replay" }); return { ok: true, status: "attached", readOnly: false }; }
    return { ok: true, status: "ok" };
  });
});
afterEach(() => { Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: undefined }); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("managed terminal", () => {
  it("renders every synthetic managed state with one CLI surface and no artificial input or focus ring", () => {
    const { container } = render(<SessionTerminalSection />);
    for (const label of ["Managed live", "Starting before binding", "Reconnecting", "Host unavailable", "New launch failed", "Incompatible host", "Queued start"]) {
      expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
    }
    expect(screen.getByText("Waiting for the session to report")).toBeInTheDocument();
    expect(screen.getByText("Reconnection unavailable. The session may still be running.")).toBeInTheDocument();
    expect(screen.getByText("This session runs in an older host and is temporarily inaccessible.")).toBeInTheDocument();
    expect(container.querySelectorAll(".sessionManagedTerminal")).toHaveLength(6);
    expect(container.querySelector("input, textarea")).toBeNull();
    const styles = readFileSync(join(process.cwd(), "app", "styles", "session.css"), "utf8");
    expect(styles).toMatch(/\.sessionTerminalEmulator \.xterm[^}]+outline: none/u);
  });
  it("subscribes before replay, streams output, sends keys and resize, and detaches without stopping on close", async () => {
    const view = render(<ManagedTerminalPanel terminal={entry} />);
    await waitFor(() => expect(fake.write).toHaveBeenCalledWith("replay", expect.any(Function)));
    emit("output", { data: "live" });
    expect(fake.write.mock.calls.map(([data]) => data)).toEqual(["replay", "live"]);
    await act(async () => fake.data?.("hello\r\u0003"));
    expect(fake.terminal).toHaveBeenCalledWith("input", expect.objectContaining({ data: "hello\r\u0003" }));
    expect(fake.terminal).toHaveBeenCalledWith("resize", expect.objectContaining({ cols: 80, rows: 24 }));
    const resized = fake.terminal.mock.calls.filter(([op]) => op === "resize").length;
    act(() => fake.resize?.());
    expect(fake.terminal.mock.calls.filter(([op]) => op === "resize")).toHaveLength(resized + 1);
    fireEvent.click(screen.getByLabelText("Live session terminal")); expect(fake.focus).toHaveBeenCalled();
    view.unmount();
    expect(fake.terminal).toHaveBeenCalledWith("detach", expect.objectContaining({ attachId: expect.any(String) }));
    expect(fake.terminal.mock.calls.some(([op]) => ["stop", "kill", "create"].includes(op))).toBe(false);
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });
  it("detaches again when an attach completes after its view closed", async () => {
    let finish!: (value: unknown) => void;
    fake.terminal.mockImplementation((op) => op === "attach" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true }));
    const view = render(<ManagedTerminalPanel terminal={entry} />);
    await waitFor(() => expect(fake.terminal).toHaveBeenCalledWith("attach", expect.anything()));
    view.unmount();
    const before = fake.terminal.mock.calls.filter(([op]) => op === "detach").length;
    await act(async () => finish({ ok: true, status: "attached" }));
    expect(fake.terminal.mock.calls.filter(([op]) => op === "detach")).toHaveLength(before + 1);
  });
  it("chunks a large Unicode paste in order within JSON frame bounds and disables input after refusal", async () => {
    render(<ManagedTerminalPanel terminal={entry} />);
    await waitFor(() => expect(fake.write).toHaveBeenCalledWith("replay", expect.any(Function)));
    const paste = "😀\u0001λ".repeat(8000);
    await act(async () => fake.data?.(paste));
    const frames = fake.terminal.mock.calls.filter(([op]) => op === "input").map(([, payload]) => payload);
    expect(frames.map((frame) => frame.data).join("")).toBe(paste);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(new TextEncoder().encode(JSON.stringify({ command: "input", ...frame })).length).toBeLessThan(16 * 1024);
    fake.terminal.mockResolvedValue({ ok: false, status: "host_unavailable" });
    await act(async () => fake.data?.("refused"));
    await screen.findByText("Reconnection unavailable. The session may still be running.");
    const count = fake.terminal.mock.calls.length;
    await act(async () => fake.data?.("later"));
    expect(fake.terminal).toHaveBeenCalledTimes(count);
  });
  it("bounds queued emulator output and detaches a slow renderer without stopping the session", async () => {
    fake.write.mockImplementation(() => {});
    render(<ManagedTerminalPanel terminal={entry} />);
    await waitFor(() => expect(fake.write).toHaveBeenCalled());
    for (let index = 0; index < 10; index += 1) emit("output", { data: "x".repeat(64 * 1024) });
    await screen.findByText("Reconnection unavailable. The session may still be running.");
    expect(fake.terminal).toHaveBeenCalledWith("detach", expect.anything());
    expect(fake.write.mock.calls.length).toBeLessThan(6);
  });
  it("disables input while reconnecting and never echoes bridge errors", async () => {
    fake.terminal.mockResolvedValue({ ok: false, status: "host_unavailable", error: "private path" });
    render(<ManagedTerminalPanel terminal={entry} />);
    await screen.findByText("Reconnection unavailable. The session may still be running.");
    act(() => fake.data?.("ignored"));
    expect(fake.terminal.mock.calls.some(([op]) => op === "input")).toBe(false);
    expect(document.body).not.toHaveTextContent("private path");
  });
  it("keeps the CLI surface when starting and names the wait for confirmed binding", async () => {
    render(<ManagedTerminalPanel terminal={{ ...entry, sessionId: null, state: "starting" }} />);
    await screen.findByText("Waiting for the session to report");
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(fake.write).toHaveBeenCalledWith("replay", expect.any(Function));
  });
  it("turns exited managed sessions into existing read-only history with a quiet exit code", async () => {
    render(<SessionTerminalPanel sessionId="codex:one" live />);
    await waitFor(() => expect(fake.write).toHaveBeenCalledWith("replay", expect.any(Function)));
    emit("exit", { exitCode: 7 });
    await screen.findByText("Process exited with code 7.");
    await screen.findByText("Read-only · Session ended");
    expect(read).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });
  it("preserves read-only fallback when no managed terminal belongs to the session", async () => {
    fake.terminal.mockResolvedValue({ ok: true, status: "ready", sessions: [], hosts: [] });
    render(<SessionTerminalPanel sessionId="codex:other" live />);
    await screen.findByText("Read-only · Running outside Pomegr · Updates automatically");
    expect(fake.terminal).toHaveBeenCalledExactlyOnceWith("list");
    expect(fake.write).not.toHaveBeenCalled();
  });
  it("shows a fixed incompatible-host notice without claiming association with a session", async () => {
    fake.terminal.mockResolvedValue({ ok: true, status: "ready", sessions: [], hosts: [{ state: "incompatible_host" }] });
    render(<SessionTerminalPanel sessionId="codex:other" live />);
    await screen.findByText("An older terminal host is temporarily inaccessible.");
    await screen.findByText("Read-only · Running outside Pomegr · Updates automatically");
  });
});

describe("task start terminal", () => {
  it("reacts to an unbound card's same-page terminal link and shows a pre-binding exit quietly", async () => {
    fake.terminal.mockImplementation(async (op, payload) => op === "list"
      ? { ok: true, status: "ready", sessions: [{ ...entry, sessionId: null, state: "starting" }], hosts: [] }
      : op === "attach" ? { ok: true, status: "attached", readOnly: false, attachId: payload.attachId } : { ok: true });
    const content = <p><TaskTerminalHint taskId="T-1" /></p>;
    const view = render(<TaskTerminalBoundary repositoryId="repo-one" revision="1">{content}</TaskTerminalBoundary>);
    const link = await screen.findByRole("link", { name: "Waiting in terminal" });
    expect(link).toHaveAttribute("href", "/tasks?repository=repo-one&terminal=T-1");
    window.history.replaceState(null, "", link.getAttribute("href")!);
    view.rerender(<TaskTerminalBoundary repositoryId="repo-one" revision="1">{content}</TaskTerminalBoundary>);
    await screen.findByText("Waiting for the session to report");
    emit("exit", { exitCode: 3 });
    await screen.findByText("Process exited with code 3.");
    expect(screen.queryByLabelText("Live session terminal")).not.toBeInTheDocument();
  });
  it("keeps a failed new start separate from an old exited terminal and retries only on an owner action", async () => {
    fake.terminal.mockResolvedValue({ ok: true, status: "ready", sessions: [{ ...entry, state: "exited", exitCode: 0 }], hosts: [] });
    const taskStart = vi.fn(async () => ({ status: "failed" }));
    (window as unknown as { pomegrDesktop: { taskStart: typeof taskStart } }).pomegrDesktop.taskStart = taskStart;
    render(<TaskTerminalBoundary repositoryId="repo-one" revision="1"><p>Board</p></TaskTerminalBoundary>);
    await act(async () => { await startDesktopTask("repo-one", "T-1"); });
    await screen.findByText("The session could not be started.");
    expect(taskStart).toHaveBeenCalledTimes(1);
    expect(fake.replace).not.toHaveBeenCalledWith("/sessions/codex-one?tab=terminal", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Start session again" }));
    await waitFor(() => expect(taskStart).toHaveBeenCalledTimes(2));
  });
  it("opens only a manual start view and moves to the bound session's Terminal", async () => {
    fake.terminal.mockResolvedValue({ ok: true, status: "ready", sessions: [{ ...entry, sessionId: null, state: "starting" }], hosts: [] });
    const view = render(<TaskTerminalBoundary repositoryId="repo-one" revision="1"><p>Board</p></TaskTerminalBoundary>);
    await act(async () => { await startDesktopTask("repo-one", "T-1"); });
    await screen.findByText("Waiting for the session to report");
    expect(fake.replace).toHaveBeenCalledWith("/tasks?repository=repo-one&terminal=T-1", { scroll: false });
    fake.terminal.mockResolvedValue({ ok: true, status: "ready", sessions: [entry], hosts: [] });
    view.rerender(<TaskTerminalBoundary repositoryId="repo-one" revision="2"><p>Board</p></TaskTerminalBoundary>);
    await waitFor(() => expect(fake.replace).toHaveBeenCalledWith("/sessions/codex-one?tab=terminal", { scroll: false }));
  });
  it("does not open the view just because a queued terminal exists", async () => {
    render(<TaskTerminalBoundary repositoryId="repo-one" revision="1"><p>Board</p></TaskTerminalBoundary>);
    await waitFor(() => expect(fake.terminal).toHaveBeenCalledWith("list"));
    expect(screen.getByText("Board")).toBeInTheDocument();
    expect(fake.replace).not.toHaveBeenCalled();
  });
});
