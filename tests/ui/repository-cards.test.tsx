import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot, RepositoryProviderInventory, RepositorySummary } from "../../shared/monitor-contract";
import type { RepositoryPluginSetup } from "../../shared/repository-plugin-contract";

const inventory = vi.hoisted(() => ({ snapshot: null as unknown as RepositoryInventorySnapshot, loading: false, connected: true }));
vi.mock("../../app/repository-inventory-client", () => ({
  useRepositoryInventory: () => ({ snapshot: inventory.snapshot, loading: inventory.loading, connected: inventory.connected, refresh: vi.fn(async () => {}) }),
}));

import { RepositoryInventoryView } from "../../app/components/repositories/RepositoryInventoryView";

const checkedAt = "2026-09-04T10:00:00.000Z";
const plugin = (overrides: Partial<RepositoryPluginSetup> = {}): RepositoryPluginSetup => ({
  readiness: "ready", installation: "installed", version: "0.5.0", enabled: true, scope: "user", checkedAt, update: { status: "current", version: null, checkedAt }, canInstall: false, canUpdate: false, ...overrides,
});
const provider = (overrides: Partial<RepositoryProviderInventory> = {}): RepositoryProviderInventory => ({
  provider: "claude", source: "Claude Code", sessionCount: 1, supported: true, status: "current", failureKind: null, currentRevision: null, revisions: [], pluginSetup: plugin(), ...overrides,
});
const codex = () => provider({ provider: "codex", source: "Codex", supported: false, status: "unavailable" });
let counter = 0;
const repository = (displayName: string, overrides: Partial<RepositorySummary> = {}): RepositorySummary => {
  counter += 1;
  return {
    id: `repo-${counter.toString(16).padStart(24, "0")}`, name: displayName, displayName, sessionCount: 42, liveCount: 0, historyCount: 42, providerCount: 1,
    updatedAt: new Date(Date.now() - 39 * 3_600_000).toISOString(), providers: [provider()], reporting: { status: "configured", version: 1, checkedAt },
    dailySessions: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0], ...overrides,
  };
};
const serve = (...repositories: RepositorySummary[]) => { inventory.snapshot = { revision: 1, readiness: "ready", repositories }; };
const articleOf = (name: string) => screen.getAllByRole("article").find((article) => article.querySelector("h3")?.textContent === name)!;
const hasClass = (element: Element | null, name: string) => (element?.className ?? "").toString().split(" ").some((value) => value.includes(name));

beforeEach(() => {
  counter = 0;
  inventory.loading = false;
  inventory.connected = true;
});
afterEach(() => cleanup());

describe("a repository card that is live", () => {
  const days = [3, 5, 2, 0, 4, 6, 7, 3, 5, 8, 6, 4, 9, 7];
  beforeEach(() => serve(repository("Clapline", { liveCount: 2, historyCount: 40, sessionCount: 42, updatedAt: new Date().toISOString(), providers: [provider(), codex()], dailySessions: days })));

  it("draws the tile, the live state with its pulse, the providers, the counts and the setup", () => {
    render(<RepositoryInventoryView />);
    const article = articleOf("Clapline");
    const view = within(article);
    expect(view.getByRole("link", { name: "Clapline, Ready" })).toHaveAttribute("href", expect.stringMatching(/^\/repositories\/repo-/));
    expect(article.querySelector("[aria-hidden='true']")).toHaveTextContent("C");
    expect(view.getByText("2 running now · active just now")).toBeInTheDocument();
    expect(article.querySelector("[class*=pulse]")).not.toBeNull();
    const providers = view.getByRole("list", { name: "Providers" });
    expect(within(providers).getAllByRole("listitem").map((item) => [item.getAttribute("title"), item.textContent])).toEqual([["Claude Code", "CClaude Code"], ["Codex", "XCodex"]]);
    expect(view.getByText("live").closest("span")).toHaveTextContent("2 live");
    expect(view.getByText("sessions").closest("span")).toHaveTextContent("42 sessions");
    expect(view.getByText("Ready")).toBeInTheDocument();
    // Ready needs nothing of the owner: no fix line, no setup link.
    expect(view.queryByText(/Set up/)).not.toBeInTheDocument();
  });

  it("draws 14 bars from the daily counts, the last one live", () => {
    render(<RepositoryInventoryView />);
    const bars = within(articleOf("Clapline")).getByRole("img");
    expect(bars).toHaveAccessibleName(/^69 sessions started in the last 14 days.*3, 5, 2, 0, 4, 6, 7, 3, 5, 8, 6, 4, 9, 7$/);
    const items = [...bars.children] as HTMLElement[];
    expect(items).toHaveLength(14);
    expect(items.map((item) => item.style.height)).toEqual(["12px", "20px", "8px", "3px", "16px", "24px", "28px", "12px", "20px", "32px", "24px", "16px", "36px", "28px"]);
    expect(items.map((item) => hasClass(item, "isEmpty"))).toEqual(days.map((count) => count === 0));
    expect(items.map((item) => hasClass(item, "isLive"))).toEqual([...Array(13).fill(false), true]);
  });
});

describe("a repository card that is not live", () => {
  it("says when it was last active, with no pulse and no live bar", () => {
    serve(repository("frontend", { liveCount: 0, historyCount: 1, sessionCount: 1, dailySessions: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0] }));
    render(<RepositoryInventoryView />);
    const article = articleOf("frontend");
    expect(within(article).getByText("last active 39h ago")).toBeInTheDocument();
    expect(article.querySelector("[class*=pulse]")).toBeNull();
    expect([...within(article).getByRole("img").children].some((item) => hasClass(item, "isLive"))).toBe(false);
    expect(within(article).getByText("live").closest("span")).toHaveTextContent("0 live");
    expect(within(article).getByRole("list", { name: "Providers" })).toBeInTheDocument();
  });

  it("draws no bars where the monitor sent no series, and never a row of zeros for it", () => {
    serve(repository("Older monitor", { dailySessions: undefined }));
    render(<RepositoryInventoryView />);
    expect(within(articleOf("Older monitor")).queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("the setup of a card", () => {
  it("is Ready with no fix line, and Ready with one while a plugin update waits", () => {
    serve(repository("Alpha"), repository("Beta", { providers: [provider({ pluginSetup: plugin({ canUpdate: true, update: { status: "available", version: "0.6.0", checkedAt } }) })] }));
    render(<RepositoryInventoryView />);
    expect(within(articleOf("Alpha")).getByText("Ready")).toBeInTheDocument();
    expect(within(articleOf("Alpha")).queryByText("Set up")).not.toBeInTheDocument();
    const beta = within(articleOf("Beta"));
    expect(beta.getByText("Ready")).toBeInTheDocument();
    expect(beta.getByText("A newer Pomegr plugin is available here.")).toBeInTheDocument();
    // The card is still named with the specific state, as the row link was.
    expect(beta.getByRole("link", { name: "Beta, Plugin update available" })).toBeInTheDocument();
  });

  it("is Setup unverified with its fix line and a Set up link to the Plugin tab", () => {
    serve(repository("Gamma", { reporting: undefined }));
    render(<RepositoryInventoryView />);
    const view = within(articleOf("Gamma"));
    expect(view.getByText("Setup unverified")).toBeInTheDocument();
    expect(view.getByText("Pomegr has not confirmed its plugin here yet.")).toBeInTheDocument();
    expect(view.getByRole("link", { name: "Set up Gamma" })).toHaveAttribute("href", expect.stringMatching(/^\/repositories\/repo-[0-9a-f]{24}\?tab=plugin$/));
  });

  it("is Reporting off with its fix line and a Set up link to the Reporting tab", () => {
    serve(repository("Delta", { reporting: { status: "missing", version: null, checkedAt } }));
    render(<RepositoryInventoryView />);
    const view = within(articleOf("Delta"));
    expect(view.getByText("Reporting off")).toBeInTheDocument();
    expect(view.getByText("Agents here do not report their state to Pomegr.")).toBeInTheDocument();
    expect(view.getByRole("link", { name: "Set up Delta" })).toHaveAttribute("href", expect.stringMatching(/\?tab=reporting$/));
  });

  it("is Reporting off for a plugin that is not installed, with a link to the Plugin tab, and Setup unverified without a line while it is checked", () => {
    serve(
      repository("Epsilon", { providers: [provider({ pluginSetup: plugin({ installation: "not_installed", version: null, enabled: null }) })] }),
      repository("Zeta", { providers: [provider({ pluginSetup: plugin({ readiness: "loading" }) })] }),
    );
    render(<RepositoryInventoryView />);
    expect(within(articleOf("Epsilon")).getByText("Reporting off")).toBeInTheDocument();
    expect(within(articleOf("Epsilon")).getByRole("link", { name: "Set up Epsilon" })).toHaveAttribute("href", expect.stringMatching(/\?tab=plugin$/));
    expect(within(articleOf("Zeta")).getByText("Setup unverified")).toBeInTheDocument();
    expect(within(articleOf("Zeta")).queryByText(/Set up/)).not.toBeInTheDocument();
  });
});

describe("the list", () => {
  it("is one card for each repository, in the order the monitor sent, and the name is the card's one link besides the fix", () => {
    serve(repository("Alpha"), repository("Beta", { reporting: undefined }));
    render(<RepositoryInventoryView />);
    expect(screen.getAllByRole("article").map((article) => within(article).getByRole("heading").textContent)).toEqual(["Alpha", "Beta"]);
    expect(within(articleOf("Alpha")).getAllByRole("link")).toHaveLength(1);
    expect(within(articleOf("Beta")).getAllByRole("link")).toHaveLength(2);
  });

  it("keeps the search and the three filters, and their count", async () => {
    serve(
      repository("Alpha"),
      repository("Beta", { liveCount: 1 }),
      repository("Gamma", { providers: [provider({ pluginSetup: plugin({ enabled: false }) })] }),
      // Reporting that is not configured is drawn Reporting off, and is not a warning: the filter keeps today's rule.
      repository("Delta", { reporting: { status: "missing", version: null, checkedAt } }),
    );
    render(<RepositoryInventoryView />);
    const names = () => screen.getAllByRole("article").map((article) => within(article).getByRole("heading").textContent);
    expect(screen.getByText("4 repositories · 1 needs attention")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getByRole("button", { name: "Needs attention" })).toHaveAttribute("aria-pressed", "true");
    expect(names()).toEqual(["Gamma"]);
    await userEvent.click(screen.getByRole("button", { name: "Live now" }));
    expect(names()).toEqual(["Beta"]);
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter repositories" }), " ALP ");
    expect(names()).toEqual(["Alpha"]);
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), "nothing like it");
    expect(screen.getByText("No repositories match")).toBeInTheDocument();
  });

  it("says why it is empty, and draws no card", async () => {
    serve(repository("Alpha"));
    render(<RepositoryInventoryView />);
    await userEvent.click(screen.getByRole("button", { name: "Live now" }));
    expect(screen.getByText("No repositories are live now")).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("no longer carries the developer note under the list", () => {
    serve(repository("Alpha"));
    render(<RepositoryInventoryView />);
    expect(screen.queryByText(/Rows reflect session associations only/)).not.toBeInTheDocument();
    expect(screen.queryByText(/bounded repository summary/)).not.toBeInTheDocument();
    expect(document.querySelector(".commandRepositoryFootnote")).toBeNull();
  });
});
