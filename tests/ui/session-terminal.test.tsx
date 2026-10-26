import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../../app/live-events";
import { Dashboard } from "../../app/Dashboard";
import { DisplayPreferencesProvider } from "../../app/hooks/DisplayPreferencesContext";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { resetSessionDomainStoreForTests } from "../../app/session-domain-store";
import { encodeSessionRoute } from "../../shared/session-route.mjs";
import { SessionTabs } from "../../app/components/dashboard/SessionTabs";
import { parseSessionTab } from "../../app/components/dashboard/session-route";
import { SessionTerminalPanel } from "../../app/components/dashboard/session-terminal/SessionTerminalPanel";
import { sessionSummaryFixture } from "./session-summary-test-fixture";

const stream = vi.hoisted(() => ({ listener: null as ((event: LiveEvent) => void) | null, unsubscribe: vi.fn() }));
vi.mock("../../app/live-events", () => ({ subscribeLiveEvents: (listener: (event: LiveEvent) => void) => {
  stream.listener = listener;
  return stream.unsubscribe;
} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: { disableStdin: boolean };
  cols = 80;
  rows = 24;
  constructor(options: { disableStdin: boolean }) { this.options = options; }
  loadAddon() {}
  open() {}
  focus() {}
  onData() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
  write(_data: string, done?: () => void) { done?.(); }
  dispose() {}
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
const cursor = { fingerprint: "first", offset: 100 };
const older = { fingerprint: "first", offset: 10 };
const owner = (text: string) => ({ kind: "owner", at: null, text });
const agent = (text: string) => ({ kind: "agent", at: null, text });
const page = (messages: unknown[] = [owner("Read the change"), agent("I will check it.")], fields = {}) => ({
  ok: true, page: { messages, cursor, older: null, reset: false, status: "ok", ...fields },
});
const read = vi.fn();
const sessionContinue = vi.fn();
const terminal = vi.fn();
let outputListener: ((event: { attachId: string; event: "output" | "exit" | "detached"; exitCode?: number }) => void) | null = null;
function bridge(present = true, desktop = false) { Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: present ? {
  sessionHistory: read, ...(desktop ? { sessionContinue, terminal, onTerminalOutput: (listener: typeof outputListener) => { outputListener = listener; return () => {}; } } : {}),
} : undefined }); }
function visibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  fireEvent(document, new Event("visibilitychange"));
}
function emit(sessionId = "codex:one", domain: "session-summary" | "agents" = "session-summary") {
  act(() => stream.listener?.({ type: "revision", sessionId, domain, revision: 2, epoch: 1 }));
}
function mount(live = true, sessionId = "codex:one") { return render(<SessionTerminalPanel sessionId={sessionId} live={live} />); }
async function loaded() { await screen.findByText("I will check it."); }

beforeEach(() => { read.mockReset().mockResolvedValue(page()); sessionContinue.mockReset(); terminal.mockReset().mockResolvedValue({ ok: true, sessions: [] }); outputListener = null; bridge(); visibility("visible"); stream.unsubscribe.mockClear(); });
afterEach(() => { bridge(false); resetSessionDomainStoreForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Terminal tab availability", () => {
  const tabs = (onSelect = vi.fn()) => <SessionTabs active="terminal" task="absent" summary={sessionSummaryFixture()} onSelect={onSelect} />;
  it("is absent without the bridge and falls back from a deep link", () => {
    bridge(false);
    const select = vi.fn();
    render(tabs(select));
    expect(screen.queryByRole("tab", { name: "Terminal" })).not.toBeInTheDocument();
    expect(select).toHaveBeenCalledWith("overview");
  });
  it("is absent from server rendering even when the test window has a bridge", () => {
    expect(renderToString(tabs())).not.toContain("session-tab-terminal");
    expect(read).not.toHaveBeenCalled();
  });
  it("is last on desktop, appears in More, and accepts a deep link", () => {
    const select = vi.fn();
    render(tabs(select));
    const desktop = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    expect(within(desktop).getAllByRole("tab").at(-1)).toHaveTextContent("Terminal");
    expect(parseSessionTab("terminal")).toBe("terminal");
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    expect(select).toHaveBeenCalledWith("terminal");
  });
});

describe("SessionTerminalPanel", () => {
  it("renders GFM tables in saved agent history", async () => {
    read.mockResolvedValue(page([agent("| Proof | Result |\n|---|---|\n| `npm test` | Pass |\n| `npm run lint` | Pass |\n\n> *Reviewed*\n\n- [x] Done")]));
    const { container } = mount();
    await screen.findByRole("table");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelector("td code")).toHaveTextContent("npm test");
    expect(container.querySelector("blockquote em")).toHaveTextContent("Reviewed");
    expect(container.querySelector("input")).toBeNull();
  });
  it.each([false, true])("opens owner and agent history links only with the bridge capability (%s)", async (available) => {
    const url = "https://github.com/o/r/pull/927";
    const text = `[PR #927](${url})`;
    const openSessionLink = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: {
      sessionHistory: read, ...(available ? { openSessionLink } : {}),
    } });
    read.mockResolvedValue(page([owner(text), agent(text)]));
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll(".sessionTerminalMessage")).toHaveLength(2));
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(available ? 2 : 0);
    if (available) {
      fireEvent.click(links[0]);
      expect(openSessionLink).toHaveBeenCalledExactlyOnceWith(url);
    } else expect(container.textContent).toContain(text);
  });

  it.each([false, true])("a host exit does not authorize Continue while observation is live (continued=%s)", async (continued) => {
    bridge(true, true);
    terminal.mockResolvedValue({ ok: true, sessions: [{ key: "exited", sessionId: "codex:one", state: "exited", exitCode: 0,
      ...(continued ? { continuedFrom: "codex:one" } : {}) }] });
    mount(true); await loaded();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });
  it("formats saved messages safely, labels the owner block, and keeps the tool line literal", async () => {
    read.mockResolvedValue(page([
      owner("**Review** this"),
      agent("**bold** and `code`\n\n```ts\nfirst line\nsecond line\n```\n\n- one\n- two"),
      agent('<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n[link](https://example.test)\n![image](https://example.test/image.png)'),
      { kind: "tool", at: null, name: "**Read**", outcome: "completed" },
    ]));
    const { container } = mount();
    expect(await screen.findByText("bold", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("code", { selector: "code" })).toBeInTheDocument();
    expect(container.querySelector("pre code")?.textContent).toBe("first line\nsecond line\n");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["one", "two"]);
    const ownerMessage = screen.getByText("Review", { selector: "strong" }).closest(".sessionTerminalMessage");
    expect(ownerMessage?.textContent).toBe("YouReview this");
    expect(ownerMessage).toHaveClass("sessionTerminalOwner");
    expect(ownerMessage?.firstElementChild?.textContent).toBe("You");
    expect(container.querySelector("img, script, a")).toBeNull();
    for (const literal of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '[link](https://example.test)', '![image](https://example.test/image.png)']) {
      expect(container.textContent).toContain(literal);
    }
    const tool = screen.getByText("Tool · **Read** · completed");
    expect(tool).toHaveClass("sessionTerminalTool");
    expect(tool.children).toHaveLength(0);
  });
  it("folds a long owner prompt and opens it on Show more", async () => {
    read.mockResolvedValue(page([owner(Array.from({ length: 12 }, (_, line) => `Line ${line + 1}`).join("\n")), owner("Short")]));
    mount();
    const toggle = await screen.findByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.closest(".sessionTerminalOwner")?.querySelector(".sessionTerminalOwnerBody")).toHaveAttribute("data-folded", "true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    expect(toggle.closest(".sessionTerminalOwner")?.querySelector(".sessionTerminalOwnerBody")).not.toHaveAttribute("data-folded");
    expect(screen.getAllByRole("button", { name: /Show (more|less)/u })).toHaveLength(1);
  });

  it("uses normalized liveness even when the summary serving view is live", async () => {
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: {
      sessionHistory: read, getDesktopState: async () => null, onDesktopStateChanged: () => () => {},
    } });
    const summary = sessionSummaryFixture({ view: "live", lifecycle: { isLive: false, needsInput: false, activityStatus: "open", currentActivity: null, activityFallback: null } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(JSON.stringify(String(input).startsWith("/api/session-domain") ? summary : { sessions: [], taskReadiness: "ready" }), { status: 200 }));
    render(<LiveClockProvider running={false}><DisplayPreferencesProvider><SessionCatalogProvider sessions={[]}>
      <Dashboard initialSessionId={summary.sessionId} initialQuery={{ tab: "terminal" }} />
    </SessionCatalogProvider></DisplayPreferencesProvider></LiveClockProvider>);
    await loaded();
    expect(screen.getByText("Read-only · Session ended")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  });
  it("starts only one read under StrictMode effect replay", async () => {
    let finish!: (value: ReturnType<typeof page>) => void;
    read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<StrictMode><SessionTerminalPanel sessionId="codex:one" live /></StrictMode>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await act(async () => finish(page()));
    await loaded(); expect(read).toHaveBeenCalledTimes(1);
  });
  it("recovers a missing source without a cursor as a fresh page with older history", async () => {
    read.mockResolvedValueOnce(page([], { status: "missing", cursor: null }));
    mount(); await screen.findByText("Pomegr keeps no separate copy.");
    read.mockResolvedValue(page(undefined, { older })); emit(); await loaded();
    expect(read).toHaveBeenLastCalledWith("codex:one", {});
    expect(screen.getByRole("button", { name: "Load earlier" })).toBeInTheDocument();
  });
  it("reads once on open and renders owner, agent, and tool strings literally", async () => {
    read.mockResolvedValue(page([owner("<img src=x onerror=alert(1)>"), agent("<b>Reply</b>"), { kind: "tool", at: null, name: "<i>Read</i>", outcome: "completed" }]));
    const { container } = mount();
    expect(screen.getByText("Reading history…")).toBeInTheDocument();
    expect((await screen.findByText("<img src=x onerror=alert(1)>")).closest(".sessionTerminalMessage")).toHaveTextContent("You<img src=x onerror=alert(1)>");
    expect(screen.getByText("<b>Reply</b>")).toBeInTheDocument();
    expect(screen.getByText("Tool · <i>Read</i> · completed")).toBeInTheDocument();
    expect(container.querySelector("img, b, i, input, textarea")).toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith("codex:one", {});
  });
  it("loads earlier with before, prepends, and retains the forward cursor", async () => {
    read.mockResolvedValueOnce(page(undefined, { older })).mockResolvedValueOnce(page([owner("Earlier")], { cursor: older }));
    mount(); await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    expect((await screen.findByText("Earlier")).closest(".sessionTerminalMessage")).toHaveTextContent("YouEarlier");
    expect(read).toHaveBeenNthCalledWith(2, "codex:one", { before: older });
    expect(screen.getByLabelText("Saved session history").textContent).toMatch(/Earlier[\s\S]*Read the change[\s\S]*I will check it/);
    emit();
    await waitFor(() => expect(read).toHaveBeenNthCalledWith(3, "codex:one", { cursor }));
  });
  it("appends for this session only while visible and catches up once on visibility", async () => {
    mount(); await loaded();
    emit("codex:other"); emit("codex:one", "agents");
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(page([agent("New reply")])); emit();
    await screen.findByText("New reply");
    expect(screen.getByText("I will check it.")).toBeInTheDocument();
    expect(read).toHaveBeenLastCalledWith("codex:one", { cursor });
    visibility("hidden"); emit(); emit();
    expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValue(page([agent("Caught up")])); visibility("visible");
    await screen.findByText("Caught up"); expect(read).toHaveBeenCalledTimes(3);
  });
  it("defers the first read while hidden", async () => {
    visibility("hidden"); mount(); expect(read).not.toHaveBeenCalled();
    visibility("visible"); await loaded(); expect(read).toHaveBeenCalledTimes(1);
  });
  it("coalesces events during a read into exactly one further read", async () => {
    let finish!: (value: ReturnType<typeof page>) => void;
    read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mount(); await waitFor(() => expect(read).toHaveBeenCalledTimes(1)); emit(); emit(); emit();
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => finish(page()));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenLastCalledWith("codex:one", { cursor });
  });
  it("does not run the coalesced read after hiding or unmounting", async () => {
    let finish!: (value: ReturnType<typeof page>) => void;
    read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = mount(); await waitFor(() => expect(read).toHaveBeenCalledTimes(1)); emit(); visibility("hidden");
    await act(async () => finish(page())); expect(read).toHaveBeenCalledTimes(1);
    view.unmount(); expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
    emit(); expect(read).toHaveBeenCalledTimes(1);
  });
  it("replaces content on reset", async () => {
    mount(); await loaded();
    read.mockResolvedValue(page([agent("Replacement")], { reset: true })); emit();
    await screen.findByText("Replacement");
    expect(screen.queryByText("I will check it.")).not.toBeInTheDocument();
  });
  it.each([
    ["missing", page([], { status: "missing" }), "The provider no longer has this session's history."],
    ["empty", page([]), "No messages yet"],
    ["unsupported", page([], { status: "unsupported" }), "This provider does not support reading session history."],
  ])("renders %s", async (_name, result, text) => {
    read.mockResolvedValue(result); mount(false);
    expect(await screen.findByText(text as string)).toBeInTheDocument();
    if (_name === "missing") expect(screen.getByText("Pomegr keeps no separate copy.")).toBeInTheDocument();
    expect(screen.getByText("Read-only · Session ended")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });
  it("shows one fixed failure line and retries through Refresh or reopening", async () => {
    read.mockRejectedValueOnce(new Error("private failure"));
    const view = mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Session history could not be read.");
    expect(document.body).not.toHaveTextContent("private failure");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await loaded();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.unmount(); mount(); await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  });
  it("offers Continue only for successful ended history from supported providers on desktop", async () => {
    bridge(true, true);
    expect(renderToString(<SessionTerminalPanel sessionId="codex:one" live={false} />)).not.toContain("Continue");
    bridge(true, true); const desktop = mount(false); await loaded();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    desktop.unmount(); bridge(true, false); mount(false); await loaded();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    cleanup(); bridge(true, true); mount(true); await loaded();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    cleanup(); bridge(true, true); read.mockResolvedValue(page([], { status: "unsupported" })); mount(false, "mistral:one");
    await screen.findByText("This provider does not support reading session history.");
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    cleanup(); read.mockResolvedValue(page([], { status: "missing" })); mount(false);
    await screen.findByText("Pomegr keeps no separate copy.");
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    cleanup(); bridge(true, true); read.mockResolvedValue(page()); mount(false, "claude:one"); await loaded();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    cleanup(); bridge(true, true); read.mockRejectedValue(new Error("private failure")); mount(false);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });
  it("keeps a cancelled confirmation quiet and renders a fixed refusal reason", async () => {
    bridge(true, true); sessionContinue.mockResolvedValueOnce({ status: "cancelled" }).mockResolvedValueOnce({ status: "folder_missing" });
    const { container } = mount(false); await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(sessionContinue).toHaveBeenCalledWith("codex:one"));
    expect(screen.queryByRole("status", { name: /Continue unavailable/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Read-only · Continue unavailable: working directory is missing");
    expect(container.querySelectorAll(".sessionTerminalBar")).toHaveLength(1);
    expect(document.body).not.toHaveTextContent("folder_missing");
  });
  it("moves to the continued fork and links to its observed terminal", async () => {
    bridge(true, true);
    sessionContinue.mockResolvedValue({ status: "started" });
    let lists = 0;
    terminal.mockImplementation(async (operation: string) => operation === "list" ? ({ ok: true, sessions: ++lists === 1 ? [
      { key: "old", repositoryId: "repo", taskId: "task", sessionId: "codex:one", state: "exited" },
    ] : [
      { key: "old", repositoryId: "repo", taskId: "task", sessionId: "codex:one", state: "exited" },
      { key: "fork", repositoryId: "repo", taskId: "task", sessionId: "claude:new", continuedFrom: "codex:one", state: "live" },
    ] }) : ({ ok: true, readOnly: false }));
    mount(false); await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(terminal).toHaveBeenCalledWith("list"));
    expect(await screen.findByText("This session continued as a new session.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open continued session" })).toHaveAttribute("href", `/sessions/${encodeSessionRoute("claude:new")}?tab=terminal`);
  });
  it("attaches a same-ID continuation ahead of the old exited record and shows its exit history", async () => {
    bridge(true, true); sessionContinue.mockResolvedValue({ status: "started" });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let lists = 0;
    terminal.mockImplementation(async (operation: string) => {
      if (operation === "list") return { ok: true, sessions: ++lists === 1 ? [
        { key: "old", repositoryId: "repo", taskId: "task", sessionId: "codex:one", state: "exited" },
      ] : lists === 2 ? [
        { key: "continue", repositoryId: null, taskId: null, sessionId: "codex:one", continuedFrom: "codex:one", state: "live" },
        { key: "old", repositoryId: "repo", taskId: "task", sessionId: "codex:one", state: "exited" },
      ] : [
        { key: "continue", repositoryId: null, taskId: null, sessionId: "codex:one", continuedFrom: "codex:one", state: "exited" },
        { key: "continue2", repositoryId: null, taskId: null, sessionId: "codex:one", continuedFrom: "codex:one", state: "live" },
        { key: "old", repositoryId: "repo", taskId: "task", sessionId: "codex:one", state: "exited" },
      ] };
      if (operation === "attach") return { ok: true, readOnly: false };
      return { ok: true };
    });
    mount(false); await loaded(); fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(terminal).toHaveBeenCalledWith("attach", expect.objectContaining({ key: "continue" })));
    const attach = terminal.mock.calls.find(([operation]) => operation === "attach")?.[1] as { attachId: string };
    act(() => outputListener?.({ attachId: attach.attachId, event: "exit", exitCode: 9 }));
    expect(await screen.findByText("Process exited with code 9.")).toBeInTheDocument();
    expect(screen.getByLabelText("Saved session history")).toBeInTheDocument();
    expect(terminal.mock.calls.filter(([operation]) => operation === "attach")).toHaveLength(1);
    expect(read).toHaveBeenLastCalledWith("codex:one", {});
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(terminal).toHaveBeenCalledWith("attach", expect.objectContaining({ key: "continue2" })));
  });
  it.each(["host_unavailable", "exited"] as const)("leaves the starting state when the continued record is %s", async (state) => {
    bridge(true, true); sessionContinue.mockResolvedValue({ status: "started" });
    let lists = 0;
    terminal.mockImplementation(async (operation: string) => operation === "list" ? { ok: true, sessions: ++lists === 1 ? [
      { key: "old", repositoryId: "repo", taskId: "task", sessionId: "codex:one", state: "exited" },
    ] : [
      { key: "continued", repositoryId: null, taskId: null, sessionId: "codex:one", continuedFrom: "codex:one", state, exitCode: 4 },
    ] } : ({ ok: true }));
    mount(false); await loaded(); fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    if (state === "host_unavailable") expect(await screen.findByText("Reconnection unavailable. The session may still be running.")).toBeInTheDocument();
    else expect(await screen.findByText("Process exited with code 4.")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for the session to report")).not.toBeInTheDocument();
  });
  it("keeps the fork notice after exit and follows a second continuation", async () => {
    bridge(true, true); sessionContinue.mockResolvedValue({ status: "started" });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let lists = 0;
    terminal.mockImplementation(async (operation: string) => {
      if (operation !== "list") return { ok: true, readOnly: false };
      lists++;
      if (lists === 1) return { ok: true, sessions: [{ key: "old", repositoryId: "repo", taskId: "task", sessionId: "codex:one", state: "exited" }] };
      if (lists === 2) return { ok: true, sessions: [{ key: "first", repositoryId: null, taskId: null, sessionId: "codex:first", continuedFrom: "codex:one", state: "live" }] };
      if (lists === 3) return { ok: true, sessions: [
        { key: "old", repositoryId: "repo", taskId: "task", sessionId: "codex:one", state: "exited" },
        { key: "first", repositoryId: null, taskId: null, sessionId: "codex:first", continuedFrom: "codex:one", state: "exited" },
      ] };
      return { ok: true, sessions: [
        { key: "old", repositoryId: "repo", taskId: "task", sessionId: "codex:one", state: "exited" },
        { key: "first", repositoryId: null, taskId: null, sessionId: "codex:first", continuedFrom: "codex:one", state: "exited" },
        { key: "second", repositoryId: null, taskId: null, sessionId: "codex:second", continuedFrom: "codex:first", state: "live" },
      ] };
    });
    mount(false); await loaded(); fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(terminal).toHaveBeenCalledWith("attach", expect.objectContaining({ key: "first" })));
    const firstAttach = terminal.mock.calls.find(([, payload]) => (payload as { key?: string })?.key === "first")?.[1] as { attachId: string };
    act(() => outputListener?.({ attachId: firstAttach.attachId, event: "exit", exitCode: 0 }));
    expect(await screen.findByText("This session continued as a new session.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Live session terminal")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Saved session history")).toBeInTheDocument();
    expect(read).toHaveBeenLastCalledWith("codex:one", {});
    expect(screen.getByRole("link", { name: "Open continued session" })).toHaveAttribute("href", `/sessions/${encodeSessionRoute("codex:first")}?tab=terminal`);
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    cleanup(); mount(false, "codex:first"); await loaded(); fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(terminal).toHaveBeenCalledWith("attach", expect.objectContaining({ key: "second" })));
    expect(screen.getByRole("link", { name: "Open continued session" })).toHaveAttribute("href", `/sessions/${encodeSessionRoute("codex:second")}?tab=terminal`);
  });
  it("Refresh reads with the cursor", async () => {
    mount(); await loaded();
    expect(screen.getByText("Read-only · Running outside Pomegr · Updates automatically")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenLastCalledWith("codex:one", { cursor });
  });
  it("follows the bottom but preserves a scrolled-up position", async () => {
    mount(); await loaded();
    const output = screen.getByLabelText("Saved session history");
    let height = 1000;
    Object.defineProperties(output, { scrollHeight: { configurable: true, get: () => height }, clientHeight: { configurable: true, value: 200 } });
    output.scrollTop = 800; fireEvent.scroll(output);
    height = 1100; read.mockResolvedValue(page([agent("At bottom")])); emit();
    await screen.findByText("At bottom"); expect(output.scrollTop).toBe(1100);
    output.scrollTop = 300; fireEvent.scroll(output);
    height = 1200; read.mockResolvedValue(page([agent("While reading")])); emit();
    await screen.findByText("While reading"); expect(output.scrollTop).toBe(300);
  });
});
