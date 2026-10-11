import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

import { Dashboard } from "../../app/Dashboard";
import { DisplayPreferencesProvider } from "../../app/hooks/DisplayPreferencesContext";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { resetSessionDomainStoreForTests } from "../../app/session-domain-store";
import { resetTasksStoreForTests } from "../../app/tasks-store";
import { sessionSummaryFixture } from "./session-summary-test-fixture";

const REPOSITORY = `repo-${"a".repeat(24)}`;
const REFERENCE = { id: "T-14", repositoryId: REPOSITORY, state: null, featureId: "feat-0123456789ab", feature: "Task board v1", step: 2 };

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }

/** The session view with a directory answer for its own row; the task board itself stays unreadable (403). */
function mount(directory: (sessionId: string) => unknown, tab?: string) {
  const summary = sessionSummaryFixture();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/session-domain")) return json(summary);
    if (url.startsWith("/api/sessions?")) return json(directory(summary.sessionId));
    return new Response(null, { status: url.startsWith("/api/tasks") ? 403 : 404 });
  });
  render(<LiveClockProvider running={false}><DisplayPreferencesProvider><SessionCatalogProvider sessions={[]}><Dashboard initialSessionId={summary.sessionId} initialQuery={tab ? { tab } : {}} /></SessionCatalogProvider></DisplayPreferencesProvider></LiveClockProvider>);
  return { summary, fetchMock };
}

afterEach(() => { resetSessionDomainStoreForTests(); resetTasksStoreForTests(); vi.restoreAllMocks(); });

describe("session view task surfaces", () => {
  it("shows the task in the header, one task row on Overview, and Task as the last tab", async () => {
    const { summary, fetchMock } = mount((id) => ({ sessions: [{ id, task: REFERENCE }], taskReadiness: "ready" }));
    await screen.findByRole("heading", { name: summary.session!.title });
    // The first tablist is the desktop one; the phone list keeps Task in its More menu.
    await screen.findAllByRole("tab", { name: "Task" });
    const tabs = screen.getAllByRole("tablist", { name: "Session sections" })[0];
    expect(within(tabs).getAllByRole("tab").at(-1)).toHaveTextContent("Task");
    const taskLinks = screen.getAllByRole("link", { name: /T-14/u });
    expect(taskLinks.length).toBeGreaterThanOrEqual(2); // header meta and the Overview row heading
    for (const link of taskLinks) expect(link.getAttribute("href")).toMatch(/\?tab=task$/u);
    expect(screen.getAllByText(/Task board v1/u).length).toBeGreaterThan(0);
    const own = fetchMock.mock.calls.map(([input]) => String(input)).find((url) => url.startsWith("/api/sessions?"))!;
    expect(new URLSearchParams(own.split("?")[1]).get("session")).toBe(summary.sessionId);
  });

  it("shows no task surface for a session with no task, or for a client that gets no reference", async () => {
    for (const directory of [(id: string) => ({ sessions: [{ id, task: null }], taskReadiness: "ready" }), (id: string) => ({ sessions: [{ id }], taskReadiness: "desktop_only" })]) {
      const { summary, fetchMock } = mount(directory);
      await screen.findByRole("heading", { name: summary.session!.title });
      await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/sessions?"))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByRole("tab", { name: "Task" })).not.toBeInTheDocument();
      expect(screen.queryByText(/T-14/u)).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/tasks"))).toBe(false);
      document.body.innerHTML = "";
      resetSessionDomainStoreForTests(); vi.restoreAllMocks();
    }
  });

  it("opens the Task tab from a deep link with the task ID plain in the header", async () => {
    const { summary } = mount((id) => ({ sessions: [{ id, task: REFERENCE }], taskReadiness: "ready" }), "task");
    await screen.findByRole("heading", { name: summary.session!.title });
    expect((await screen.findAllByRole("tab", { name: "Task", selected: true })).length).toBeGreaterThan(0);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("T-14");
    for (const link of screen.queryAllByRole("link", { name: /T-14/u })) expect(link.getAttribute("href")).not.toMatch(/\?tab=task$/u);
  });
});
