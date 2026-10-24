import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../../app/live-events";
import { Dashboard } from "../../app/Dashboard";
import { DisplayPreferencesProvider } from "../../app/hooks/DisplayPreferencesContext";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { resetSessionDomainStoreForTests } from "../../app/session-domain-store";
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
const cursor = { fingerprint: "first", offset: 100 };
const older = { fingerprint: "first", offset: 10 };
const owner = (text: string) => ({ kind: "owner", at: null, text });
const agent = (text: string) => ({ kind: "agent", at: null, text });
const page = (messages: unknown[] = [owner("Read the change"), agent("I will check it.")], fields = {}) => ({
  ok: true, page: { messages, cursor, older: null, reset: false, status: "ok", ...fields },
});
const read = vi.fn();
function bridge(present = true) { Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: present ? { sessionHistory: read } : undefined }); }
function visibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  fireEvent(document, new Event("visibilitychange"));
}
function emit(sessionId = "codex:one", domain: "session-summary" | "agents" = "session-summary") {
  act(() => stream.listener?.({ type: "revision", sessionId, domain, revision: 2, epoch: 1 }));
}
function mount(live = true) { return render(<SessionTerminalPanel sessionId="codex:one" live={live} />); }
async function loaded() { await screen.findByText("I will check it."); }

beforeEach(() => { read.mockReset().mockResolvedValue(page()); bridge(); visibility("visible"); stream.unsubscribe.mockClear(); });
afterEach(() => { bridge(false); resetSessionDomainStoreForTests(); vi.restoreAllMocks(); });

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
  it("formats saved messages safely and keeps the owner prefix and tool line literal", async () => {
    read.mockResolvedValue(page([
      owner("**Review** this"),
      agent("**bold** and `code`\n\n```ts\nfirst line\nsecond line\n```\n\n- one\n- two"),
      agent('<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n[link](https://example.test)\n![image](https://example.test/image.png)'),
      { kind: "tool", at: null, name: "**Read**", outcome: "completed" },
    ]));
    const { container } = mount();
    expect(await screen.findByText("bold", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("code", { selector: "code" })).toBeInTheDocument();
    expect(container.querySelector("pre code")?.textContent).toBe("first line\nsecond line");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["one", "two"]);
    const ownerMessage = screen.getByText("Review", { selector: "strong" }).closest(".sessionTerminalMessage");
    expect(ownerMessage?.textContent).toBe("> Review this");
    expect(ownerMessage?.firstElementChild?.textContent).toBe("> ");
    expect(container.querySelector("img, script, a")).toBeNull();
    for (const literal of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '[link](https://example.test)', '![image](https://example.test/image.png)']) {
      expect(container.textContent).toContain(literal);
    }
    const tool = screen.getByText("Tool · **Read** · completed");
    expect(tool).toHaveClass("sessionTerminalTool");
    expect(tool.children).toHaveLength(0);
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
    expect((await screen.findByText("<img src=x onerror=alert(1)>")).closest(".sessionTerminalMessage")).toHaveTextContent("> <img src=x onerror=alert(1)>");
    expect(screen.getByText("<b>Reply</b>")).toBeInTheDocument();
    expect(screen.getByText("Tool · <i>Read</i> · completed")).toBeInTheDocument();
    expect(container.querySelector("img, b, i, input, textarea")).toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith("codex:one", {});
  });
  it("loads earlier with before, prepends, and retains the forward cursor", async () => {
    read.mockResolvedValueOnce(page(undefined, { older })).mockResolvedValueOnce(page([owner("Earlier")], { cursor: older }));
    mount(); await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    expect((await screen.findByText("Earlier")).closest(".sessionTerminalMessage")).toHaveTextContent("> Earlier");
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
