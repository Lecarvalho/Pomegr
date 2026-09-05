import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheEvent, RequestSnapshot } from "../../shared/monitor-contract";
import { CacheEvidenceDisclosure } from "../../app/components/dashboard/CacheEvidenceDisclosure";
import { agent } from "./dashboard-test-fixtures";

const snapshot: RequestSnapshot = {
  id: "request-1",
  agentId: "primary",
  observedAt: "2026-08-09T12:00:00.000Z",
  cacheLifetime: "1h",
  uncachedInputTokens: 1_000,
  cacheWriteTokens: 10_000,
  cacheReadTokens: 0,
  outputTokens: 500,
  totalTokens: 11_500,
  precedingWork: [],
  precedingAssociation: null,
  issuedWork: [],
  issuedAssociation: null,
};

function event(id: string, observedAt: string, agentId = "primary"): CacheEvent {
  return {
    id,
    agentId,
    kind: "refill",
    observedAt,
    promptInputTokens: 10_000,
    cacheReadPercent: 5,
    cacheWriteTokens: 10_000,
    previousCacheReadPercent: null,
    gapMs: null,
    relatedEventId: null,
  };
}

function renderDisclosure(overrides: Partial<React.ComponentProps<typeof CacheEvidenceDisclosure>> = {}) {
  const events = Array.from({ length: 7 }, (_, index) => event(`event-${index}`, new Date(Date.parse("2026-08-09T12:00:00.000Z") + index * 60_000).toISOString()));
  return render(<CacheEvidenceDisclosure
    agents={[agent]}
    cacheEvents={{ status: "ready", items: events, possibleFullRefills: [] }}
    requestSnapshots={{ status: "ready", items: [snapshot] }}
    cacheWriteAvailable
    historical={false}
    {...overrides}
  />);
}

describe("cache evidence disclosure", () => {
  afterEach(() => window.localStorage.removeItem("pomegr-disclosure-cache-evidence"));

  it("starts closed and summarizes the complete event count", () => {
    const { container } = renderDisclosure();
    const details = container.querySelector("details.cacheEvidenceDisclosure")!;
    expect(details).not.toHaveAttribute("open");
    expect(details.querySelector("summary")).toHaveTextContent("Cache evidence7 events");
  });

  it("persists its open state", async () => {
    const user = userEvent.setup();
    const first = renderDisclosure();
    await user.click(first.container.querySelector("summary")!);
    expect(window.localStorage.getItem("pomegr-disclosure-cache-evidence")).toBe("true");
    first.unmount();
    const second = renderDisclosure();
    expect(second.container.querySelector("details.cacheEvidenceDisclosure")).toHaveAttribute("open");
  });

  it("reveals all events through the existing expansion control", () => {
    renderDisclosure();
    fireEvent.click(screen.getByText("Cache evidence", { selector: ".dashboardDisclosureTitle" }));
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show 2 earlier events" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
  });

  it("keeps unmatched events noninteractive and selects an exact normalized match", () => {
    const onSelectSnapshot = vi.fn();
    renderDisclosure({
      cacheEvents: { status: "ready", items: [event("unmatched", "2026-08-09T13:00:00.000Z"), event("matched", "2026-08-09T08:00:00.000-04:00")], possibleFullRefills: [] },
      onSelectSnapshot,
    });
    fireEvent.click(screen.getByText("Cache evidence", { selector: ".dashboardDisclosureTitle" }));
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    const matched = within(rows[0]).getByRole("button", { name: /Locate Cache refill/ });
    expect(within(rows[1]).queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(matched);
    expect(onSelectSnapshot).toHaveBeenCalledWith(snapshot);
  });
});
