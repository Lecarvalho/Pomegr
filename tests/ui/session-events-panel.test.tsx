import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEventsPanel } from "../../app/components/dashboard/SessionEventsPanel";
import { SessionOverview } from "../../app/components/dashboard/SessionOverview";
import { SESSION_EVENT_KINDS, type SessionEvent, type SessionEventFeed, type SessionEventKind } from "../../shared/session-domain-contract";
import { sessionSummaryFixture } from "./session-summary-test-fixture";

const sessionStyles = readFileSync(join(process.cwd(), "app", "styles", "session.css"), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Splits comment-free CSS into its top-level rules and its `@media` blocks (query plus inner rules). */
function splitMedia(css: string) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Array<{ query: string; body: string }> = [];
  let topLevel = "";
  let cursor = 0;
  for (const match of source.matchAll(/@media\s*([^{]+)\{/g)) {
    if (match.index < cursor) continue;
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0 && end < source.length) {
      const character = source[end++];
      if (character === "{") depth++; else if (character === "}") depth--;
    }
    blocks.push({ query: match[1]!.trim(), body: source.slice(match.index + match[0].length, end - 1) });
    topLevel += source.slice(cursor, match.index);
    cursor = end;
  }
  return { blocks, topLevel: topLevel + source.slice(cursor) };
}

// Built from local clock parts so the expected HH:mm holds in every time zone.
const at = (hour: number, minute: number) => new Date(2026, 8, 14, hour, minute).toISOString();
function event(id: string, kind: SessionEventKind, fields: Partial<SessionEvent> = {}): SessionEvent {
  return { id, kind, at: at(11, 29), agentId: null, agentLabel: null, durationMs: null, signal: null, progress: null, resource: null, pullRequestNumber: null, ...fields };
}
function feed(items: SessionEvent[], fields: Partial<SessionEventFeed> = {}): SessionEventFeed {
  return { readiness: "ready", items, total: items.length, ...fields };
}
function many(count: number) {
  return Array.from({ length: count }, (_, index) => event(`bulk-${index}`, "commit_observed", { at: at(11, 59 - index) }));
}
function mount(events: SessionEventFeed, onNavigate = vi.fn()) {
  return { onNavigate, ...render(<SessionEventsPanel events={events} onNavigate={onNavigate} />) };
}
function stubPhone() {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
}
const rowButtons = () => within(screen.getByRole("list")).getAllByRole("button");

type KindCase = [SessionEventKind, Partial<SessionEvent>, string, string | null, Record<string, string>];
const KIND_CASES: KindCase[] = [
  ["agent_started", { agentId: "explore-1", agentLabel: "Explore: activity feed" }, "Agent started", "Explore: activity feed", { tab: "agents", agent: "explore-1" }],
  ["agent_finished", { agentId: "explore-2", agentLabel: "Explore: summary domain", durationMs: 240_000 }, "Agent finished", "Explore: summary domain · 4m wall", { tab: "agents", agent: "explore-2" }],
  ["agent_stopped", { agentId: "explore-3", agentLabel: "Explore: tests", durationMs: 4_980_000 }, "Agent stopped", "Explore: tests · 1h 23m wall", { tab: "agents", agent: "explore-3" }],
  ["signal_reported", { signal: { label: "Privacy verified", tone: "positive" } }, "Signal reported", "Privacy verified · agent-reported", { tab: "signals" }],
  ["estimate_updated", { progress: { percent: 45, phase: "implementing" } }, "Agent estimate updated", "45% · implementing", { tab: "details" }],
  ["user_message", {}, "User message", null, { tab: "activities" }],
  ["resource_peak", { resource: "cpu_cores" }, "Resource peak", "CPU · session high", { tab: "resources" }],
  ["resource_peak", { resource: "memory_bytes" }, "Resource peak", "Memory · session high", { tab: "resources" }],
  ["resource_peak", { resource: "read_bps" }, "Resource peak", "Disk read · session high", { tab: "resources" }],
  ["resource_peak", { resource: "write_bps" }, "Resource peak", "Disk write · session high", { tab: "resources" }],
  ["commit_observed", {}, "Commit observed", "Git-observed", { tab: "repository" }],
  ["pull_request_opened", { pullRequestNumber: 43 }, "Pull request opened", "#43", { tab: "repository" }],
];

describe("SessionEventsPanel", () => {
  it("covers every event kind in the contract", () => {
    expect([...new Set(KIND_CASES.map(([kind]) => kind))].sort()).toEqual([...SESSION_EVENT_KINDS].sort());
  });

  it.each(KIND_CASES)("renders %s with its label, detail, time, and destination", async (kind, fields, label, detail, destination) => {
    const { onNavigate } = mount(feed([event("one", kind, fields)]));
    const [button] = rowButtons();
    expect(button).toHaveAccessibleName(detail ? `${label}, ${detail}, 11:29` : `${label}, 11:29`);
    // The row prints the time, the label, and the detail; nothing else.
    expect(button.textContent).toBe(`11:29${label}${detail ?? ""}`);
    expect(button.querySelector("time")).toHaveAttribute("datetime", at(11, 29));
    expect(button.querySelector(`svg[data-event-kind="${kind}"]`)).toHaveAttribute("aria-hidden", "true");
    await userEvent.setup().click(button);
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(destination);
  });

  it("opens the Agents tab without a selection when an agent event has no agent ID", async () => {
    const { onNavigate } = mount(feed([event("one", "agent_started", { agentLabel: "Explore" })]));
    await userEvent.setup().click(rowButtons()[0]!);
    expect(onNavigate).toHaveBeenCalledWith({ tab: "agents" });
  });

  it("shows only the agent label, or only the wall time, when the other part is missing", () => {
    mount(feed([
      event("a", "agent_finished", { agentId: "x", agentLabel: "Explore: tests", durationMs: null }),
      event("b", "agent_stopped", { agentId: "y", agentLabel: null, durationMs: 600_000 }),
      event("c", "agent_finished", { agentId: "z", agentLabel: "Quick one", durationMs: 12_000 }),
    ]));
    const names = rowButtons().map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["Agent finished, Explore: tests, 11:29", "Agent stopped, 10m wall, 11:29", "Agent finished, Quick one · <1m wall, 11:29"]);
  });

  it("omits a pull-request detail when the recorded creation matches no listed pull request", () => {
    mount(feed([event("one", "pull_request_opened")]));
    expect(rowButtons()[0]).toHaveAccessibleName("Pull request opened, 11:29");
  });

  it("opens Activities from the heading and labels the order", async () => {
    const { onNavigate } = mount(feed(many(2)));
    expect(screen.getByRole("region", { name: "Events" })).toBeInTheDocument();
    expect(screen.getByText("newest first")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Events" }));
    expect(onNavigate).toHaveBeenCalledWith({ tab: "activities" });
  });

  it("renders a list of one real quiet-role button per row with neutral glyphs", () => {
    const { container } = mount(feed(many(3)));
    const list = screen.getByRole("list");
    expect(list.tagName).toBe("UL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    for (const button of rowButtons()) {
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveClass("commandQuietAction", "sessionEventRow");
    }
    for (const glyph of container.querySelectorAll(".sessionEventGlyph")) {
      expect(glyph.getAttribute("class")).toBe("sessionEventGlyph");
      expect(glyph).not.toHaveAttribute("style");
    }
  });

  it("shows nine rows on desktop, then expands to every loaded event and collapses again", async () => {
    mount(feed(many(12)));
    expect(rowButtons()).toHaveLength(9);
    const expander = screen.getByRole("button", { name: "Show 3 earlier" });
    expect(expander).toHaveClass("commandTextLink");
    expect(expander).toHaveAttribute("aria-expanded", "false");
    expect(expander).toHaveAttribute("aria-controls", screen.getByRole("list").id);
    const user = userEvent.setup();
    await user.click(expander);
    expect(rowButtons()).toHaveLength(12);
    const collapse = screen.getByRole("button", { name: "Show fewer" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    await user.click(collapse);
    expect(rowButtons()).toHaveLength(9);
    expect(screen.getByRole("button", { name: "Show 3 earlier" })).toBeInTheDocument();
  });

  it("shows five rows on phone and counts the remaining loaded events", async () => {
    stubPhone();
    mount(feed(many(12)));
    expect(rowButtons()).toHaveLength(5);
    await userEvent.setup().click(screen.getByRole("button", { name: "Show 7 earlier" }));
    expect(rowButtons()).toHaveLength(12);
    expect(screen.getByRole("button", { name: "Show fewer" })).toBeInTheDocument();
  });

  it("marks the expanded list for the desktop scroll cap, never with an inline style", async () => {
    mount(feed(many(12)));
    const list = screen.getByRole("list");
    expect(list).not.toHaveAttribute("data-expanded");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show 3 earlier" }));
    expect(list).toHaveAttribute("data-expanded", "true");
    expect(list).not.toHaveAttribute("style");
    expect(list).not.toHaveAttribute("tabindex");
    await user.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(list).not.toHaveAttribute("data-expanded");
  });

  it("scrolls the expanded list inside the nine-row height from 761px up and leaves phone uncapped", () => {
    mount(feed(many(30)));
    const collapsedRows = rowButtons().length;
    const { blocks, topLevel } = splitMedia(sessionStyles);
    const desktop = blocks.filter((block) => block.query === "(min-width: 761px)" && block.body.includes(".sessionEventList"));
    expect(desktop).toHaveLength(1);
    expect(desktop[0]!.body).toMatch(/\.sessionEventList\[data-expanded="true"\]\s*\{[^}]*max-height:\s*calc\(var\(--event-row-height\) \* var\(--event-collapsed-rows\)\);[^}]*overflow-y:\s*auto/);
    // The cap derives from the row height the rows use and from the rendered collapsed row count.
    expect(Number(/--event-collapsed-rows:\s*(\d+)/.exec(topLevel)?.[1])).toBe(collapsedRows);
    expect(topLevel).toMatch(/\.sessionEventList\s*\{[^}]*--event-row-height:\s*40px/);
    expect(topLevel).toMatch(/\.sessionEventRow\.commandQuietAction\s*\{[^}]*min-height:\s*var\(--event-row-height\)/);
    // Nothing outside the min-width query, and nothing in the phone query, caps or scrolls the list.
    expect(topLevel).not.toMatch(/\.sessionEventList\[data-expanded/);
    const phone = blocks.filter((block) => block.query === "(max-width: 760px)");
    expect(phone.length).toBeGreaterThan(0);
    for (const block of phone) expect(block.body).not.toMatch(/\.sessionEventList[^{]*\{[^}]*(?:max-height|overflow)/);
  });

  it("draws the row focus ring inside the row so the scrolling list cannot clip it", () => {
    expect(sessionStyles).toMatch(/\.sessionEventRow\.commandQuietAction:focus-visible\s*\{\s*outline-offset:\s*-2px/);
  });

  it("offers no expander when every loaded event already fits", () => {
    mount(feed(many(9)));
    expect(rowButtons()).toHaveLength(9);
    expect(screen.queryByRole("button", { name: /earlier|fewer/ })).not.toBeInTheDocument();
    expect(screen.getByText("9 events")).toBeInTheDocument();
  });

  it("states the event total, singular and beyond the loaded cap, without a session claim", () => {
    const single = mount(feed(many(1)));
    expect(single.container.querySelector(".sessionEventsTotal")?.textContent).toBe("1 event");
    single.unmount();
    const beyondCap = mount(feed(many(3), { total: 1_204 }));
    expect(beyondCap.container.querySelector(".sessionEventsTotal")?.textContent).toBe("1,204 events");
    expect(beyondCap.container.querySelector(".sessionEventsFooter")?.textContent).not.toMatch(/session/i);
  });

  it("formats the total with en-US grouping whatever the runtime locale is", () => {
    const toLocaleString = Number.prototype.toLocaleString;
    // A de-DE runtime: a bare toLocaleString() would print 1.204.
    vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
      return toLocaleString.call(this, locales ?? "de-DE", options);
    });
    const { container } = mount(feed(many(3), { total: 1_204 }));
    expect(container.querySelector(".sessionEventsTotal")).toHaveTextContent("1,204 events");
  });

  it("keeps the panel but no footer when a ready feed has no events", () => {
    const { container } = mount(feed([]));
    expect(screen.getByRole("heading", { name: "Events" })).toBeInTheDocument();
    expect(screen.getByText("No events recorded.")).toHaveClass("sessionOverviewEmpty");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(container.querySelector(".sessionEventsFooter")).toBeNull();
  });

  it.each([["loading", "Loading Event evidence…", "status"], ["unavailable", "Event evidence unavailable.", null]] as const)("shows %s evidence through the shared unavailable line", (readiness, text, role) => {
    // Items beside a non-ready readiness are never trusted.
    const { container } = mount(feed(many(3), { readiness, total: 3 }));
    const message = screen.getByText(text);
    expect(message).toHaveClass("sessionOverviewEmpty");
    if (role) expect(message).toHaveAttribute("role", role); else expect(message).not.toHaveAttribute("role");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(container.querySelector(".sessionEventsFooter")).toBeNull();
    expect(screen.getByRole("button", { name: "Events" })).toBeInTheDocument();
  });

  it("skips a kind this browser does not know instead of inventing a label", () => {
    mount(feed([event("known", "commit_observed"), { ...event("future", "commit_observed"), kind: "future_kind" as SessionEventKind }]));
    expect(rowButtons()).toHaveLength(1);
    expect(rowButtons()[0]).toHaveAccessibleName("Commit observed, Git-observed, 11:29");
  });

  it("renders the label with no detail when a field has a shape this browser does not recognise", () => {
    let count = 0;
    const unknown = (kind: SessionEventKind, fields: Record<string, unknown>) => event(`unknown-${count++}`, kind, fields as Partial<SessionEvent>);
    mount(feed([
      unknown("resource_peak", { resource: "gpu_bps" }),
      unknown("resource_peak", { resource: undefined }),
      unknown("resource_peak", { resource: "toString" }),
      unknown("estimate_updated", { progress: { percent: 45, phase: 7 } }),
      unknown("estimate_updated", { progress: { percent: "45", phase: "implementing" } }),
      unknown("signal_reported", { signal: { label: 12, tone: "positive" } }),
      unknown("pull_request_opened", { pullRequestNumber: undefined }),
      unknown("pull_request_opened", { pullRequestNumber: "43" }),
      unknown("agent_finished", { agentId: 9, agentLabel: 5, durationMs: undefined }),
    ]));
    const labels = ["Resource peak", "Resource peak", "Resource peak", "Agent estimate updated", "Agent estimate updated", "Signal reported", "Pull request opened", "Pull request opened", "Agent finished"];
    expect(rowButtons().map((button) => button.getAttribute("aria-label"))).toEqual(labels.map((label) => `${label}, 11:29`));
    expect(rowButtons().map((button) => button.textContent)).toEqual(labels.map((label) => `11:29${label}`));
    expect(document.body.innerHTML).not.toMatch(/undefined|NaN|\[object|session high/);
  });

  it("opens the Agents tab without a selection when the recorded agent ID is not a usable string", async () => {
    const { onNavigate } = mount(feed([event("one", "agent_started", { agentId: 9 as unknown as string })]));
    await userEvent.setup().click(rowButtons()[0]!);
    expect(onNavigate).toHaveBeenCalledWith({ tab: "agents" });
  });

  it("renders only the fields each kind owns, never extra properties on an event", () => {
    const sentinels = { prompt: "sentinel-prompt-71b2-forbidden", command: "sentinel-command-93c4-forbidden", path: "sentinel-path-C--Users-secret-forbidden", label: "sentinel-label-5a60-forbidden", token: "sentinel-token-e1d8-forbidden" };
    const polluted = (id: string, kind: SessionEventKind, fields: Partial<SessionEvent> = {}) => ({
      ...event(id, kind, fields),
      // Properties outside the contract, and contract fields the kind does not use.
      prompt: sentinels.prompt, command: sentinels.command, transcriptPath: sentinels.path, toolOutput: sentinels.token,
      ...fields,
    });
    const { container } = mount(feed([
      polluted("a", "user_message", { agentId: "x", agentLabel: sentinels.label, durationMs: 1_000, signal: { label: sentinels.label, tone: "negative" }, pullRequestNumber: 7, resource: "cpu_cores", progress: { percent: 99, phase: "complete" } }),
      polluted("b", "commit_observed", { agentLabel: sentinels.label, signal: { label: sentinels.label, tone: "positive" } }),
      polluted("c", "agent_started", { agentLabel: "Visible agent", durationMs: 600_000, signal: { label: sentinels.label, tone: "positive" } }),
      polluted("d", "signal_reported", { agentLabel: sentinels.label, signal: { label: "Visible signal", tone: "warning" } }),
    ]));
    const names = rowButtons().map((button) => button.textContent);
    expect(names).toEqual(["11:29User message", "11:29Commit observedGit-observed", "11:29Agent startedVisible agent", "11:29Signal reportedVisible signal · agent-reported"]);
    for (const value of Object.values(sentinels)) expect(container.innerHTML).not.toContain(value);
    expect(container.innerHTML).not.toContain("99%");
  });

  it("orders the phone Overview panels Right now, Events, Requests, Repository, Progress, Work by kind, Cost", () => {
    const phoneStyles = sessionStyles.slice(sessionStyles.indexOf("@media (max-width: 760px)", sessionStyles.indexOf(".sessionEventsTotal")));
    const orderOf = (name: string) => Number(new RegExp(String.raw`\.${name}[^{]*\{[^}]*[\s;{]order:\s*(\d+)`).exec(phoneStyles)?.[1]);
    const names = ["sessionRightNow", "sessionEventsPanel", "sessionRequestStrip", "sessionRepositoryOneLine", "sessionProgressOverview", "sessionWorkOverview", "sessionCostOverview"];
    expect(names.map(orderOf)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(phoneStyles).toMatch(/\.sessionOverviewMain, \.sessionOverviewBottom\s*\{\s*display:\s*contents/);
  });

  it("uses tokens for color, a 44px phone row, and the unchanged quiet and text-link roles in its styles", () => {
    const eventRules = sessionStyles.split("\n").filter((line) => /\.sessionEvent/.test(line)).join("\n");
    expect(eventRules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(eventRules).not.toMatch(/font(?:-size)?:[^;}]*\b\d+px/);
    expect(eventRules).toMatch(/\.sessionEventRow\.commandQuietAction > svg\.sessionEventGlyph\s*\{[^}]*color:\s*var\(--command-muted\)/);
    expect(eventRules).toMatch(/\.sessionEventTime\s*\{[^}]*var\(--font-data\)/);
    expect(sessionStyles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.sessionEventRow\.commandQuietAction\s*\{[^}]*min-height:\s*(?:4[4-9]|[5-9]\d)px/);
    expect(sessionStyles).not.toMatch(/data-work="beside"|data-density/);
  });
});

describe("SessionOverview Events rail", () => {
  const eventRows = () => within(screen.getByRole("region", { name: "Events" })).getAllByRole("button", { name: /, \d\d:\d\d$/ });
  const overview = (sessionId: string) => <SessionOverview summary={sessionSummaryFixture({ sessionId, events: feed(many(12)) })} showEstimatedCost={false} onNavigate={vi.fn()} />;

  it("collapses the rail when the session changes and keeps it expanded across updates to the same session", async () => {
    const { rerender } = render(overview("claude:first"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Show 3 earlier" }));
    expect(eventRows()).toHaveLength(12);
    rerender(overview("claude:first"));
    expect(eventRows()).toHaveLength(12);
    rerender(overview("claude:second"));
    expect(eventRows()).toHaveLength(9);
    expect(screen.getByRole("button", { name: "Show 3 earlier" })).toHaveAttribute("aria-expanded", "false");
    expect(within(screen.getByRole("region", { name: "Events" })).getByRole("list")).not.toHaveAttribute("data-expanded");
  });
});
