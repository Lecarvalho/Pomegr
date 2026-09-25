import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourcesDomain } from "../../shared/session-domain-contract";
import { ResourcesTab } from "../../app/components/dashboard/ResourcesTab";

const { useSessionDomain } = vi.hoisted(() => ({ useSessionDomain: vi.fn() }));
vi.mock("../../app/session-domain-store", () => ({ useSessionDomain }));

const mebibyte = 1024 ** 2;

function domain(overrides: Partial<ResourcesDomain> = {}): ResourcesDomain {
  return {
    domain: "resources", sessionId: "claude:resources", revision: 1, readiness: "ready", observedAt: "2026-09-20T12:30:00.000Z",
    live: {
      status: "ready", reason: null,
      current: { cpuCores: 0.09, cpuMachinePercent: 1.1, memoryBytes: 512 * mebibyte, readBytesPerSecond: 32 * 1024, writeBytesPerSecond: 16 * 1024 },
      samples: [
        { timestamp: "2026-09-20T12:00:00.000Z", cpuCores: 0.05, cpuMachinePercent: 0.6, memoryBytes: 480 * mebibyte, readBytesPerSecond: 8 * 1024, writeBytesPerSecond: 4 * 1024 },
        { timestamp: "2026-09-20T12:25:00.000Z", cpuCores: 0.18, cpuMachinePercent: 2.2, memoryBytes: 611 * mebibyte, readBytesPerSecond: 4300 * 1024, writeBytesPerSecond: 2100 * 1024 },
        { timestamp: "2026-09-20T12:30:00.000Z", cpuCores: 0.09, cpuMachinePercent: 1.1, memoryBytes: 512 * mebibyte, readBytesPerSecond: 32 * 1024, writeBytesPerSecond: 16 * 1024 },
      ],
    },
    retained: {
      readiness: "ready",
      minutes: [
        { minuteStart: "2026-09-20T11:00:00.000Z", cpuCores: { min: 0.01, avg: 0.03, max: 0.06, maxAt: "2026-09-20T11:00:30.000Z" }, memoryBytes: { min: 400 * mebibyte, avg: 420 * mebibyte, max: 450 * mebibyte, maxAt: "2026-09-20T11:00:40.000Z" }, readBytesPerSecond: { min: 0, avg: 1024, max: 2048, maxAt: "2026-09-20T11:00:20.000Z" }, writeBytesPerSecond: { min: 0, avg: 512, max: 1024, maxAt: "2026-09-20T11:00:20.000Z" } },
        { minuteStart: "2026-09-20T11:01:00.000Z", cpuCores: { min: 0.02, avg: 0.1, max: 0.18, maxAt: "2026-09-20T11:01:04.000Z" }, memoryBytes: { min: 450 * mebibyte, avg: 500 * mebibyte, max: 611 * mebibyte, maxAt: "2026-09-20T11:01:04.000Z" }, readBytesPerSecond: { min: 512, avg: 2048, max: 4300 * 1024, maxAt: "2026-09-20T11:01:04.000Z" }, writeBytesPerSecond: { min: 256, avg: 1024, max: 2100 * 1024, maxAt: "2026-09-20T11:01:04.000Z" } },
      ],
      minutesTruncated: false,
      curveRemoval: null,
      peaks: [
        {
          id: "p1", field: "cpu_cores", observedAt: "2026-09-20T12:25:00.000Z", value: 0.18,
          tasks: [{ id: "task-1", workKind: "build", label: "npm run build", startedAt: "2026-09-20T12:21:00.000Z", finishedAt: "2026-09-20T12:24:10.000Z", durationMs: 190_000 }],
          matchedTaskCount: 1, request: null,
          window: { status: "retained", samples: [
            { at: "2026-09-20T12:23:00.000Z", value: 0.05 },
            { at: "2026-09-20T12:25:00.000Z", value: 0.18 },
            { at: "2026-09-20T12:27:00.000Z", value: 0.04 },
          ], minute: null },
        },
        {
          id: "p2", field: "memory_bytes", observedAt: "2026-09-20T11:01:04.000Z", value: 611 * mebibyte,
          tasks: [], matchedTaskCount: 0, request: { number: 42, uncachedInputTokens: 24 },
          window: { status: "not_retained", samples: [], minute: {
            minuteStart: "2026-09-20T11:01:00.000Z", cpuCores: null,
            memoryBytes: { min: 450 * mebibyte, avg: 500 * mebibyte, max: 611 * mebibyte, maxAt: "2026-09-20T11:01:04.000Z" },
            readBytesPerSecond: null, writeBytesPerSecond: null,
          } },
        },
      ],
    },
    ...overrides,
  };
}

function result(data: ResourcesDomain | null, error: string | null = null, unavailable = false) {
  return { data, error, fetching: false, connected: true, unavailable, revalidate: vi.fn() };
}

describe("ResourcesTab", () => {
  beforeEach(() => { useSessionDomain.mockReset(); });

  it("renders live evidence and defaults to the 30 min window", () => {
    useSessionDomain.mockReturnValue(result(domain()));
    render(<ResourcesTab sessionId="claude:resources" historical={false} />);

    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "claude:resources", domain: "resources" }, { historical: false, enabled: true });
    const segmented = screen.getByRole("group", { name: "Resource window" });
    expect(within(segmented).getByRole("button", { name: "30 min" })).toHaveAttribute("aria-pressed", "true");
    expect(within(segmented).getByRole("button", { name: "5 min" })).not.toBeDisabled();
    expect(screen.getByText(/live samples/)).toBeInTheDocument();
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("Disk I/O")).toBeInTheDocument();
    expect(screen.getByText("of one core")).toBeInTheDocument();
  });

  it("switches to the Session window and shows stored minute aggregates", async () => {
    useSessionDomain.mockReturnValue(result(domain()));
    const user = userEvent.setup();
    render(<ResourcesTab sessionId="claude:resources" historical={false} />);

    await user.click(screen.getByRole("button", { name: "Session" }));
    expect(screen.getByRole("button", { name: "Session" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/stored minute aggregates/)).toBeInTheDocument();
    expect(screen.getAllByText("Latest minute").length).toBeGreaterThan(0);
  });

  it("opens historical sessions on Session with the live segments disabled and explained", () => {
    useSessionDomain.mockReturnValue(result(domain({ live: { status: "unavailable", reason: null, current: null, samples: [] } })));
    render(<ResourcesTab sessionId="claude:resources" historical />);

    const segmented = screen.getByRole("group", { name: "Resource window" });
    expect(within(segmented).getByRole("button", { name: "Session" })).toHaveAttribute("aria-pressed", "true");
    expect(within(segmented).getByRole("button", { name: "5 min" })).toBeDisabled();
    expect(within(segmented).getByRole("button", { name: "30 min" })).toBeDisabled();
    expect(screen.getByText(/Live samples are unavailable/)).toBeInTheDocument();
  });

  it("shows a retention explanation and the peaks table when curves are pruned by age, with no fabricated zeros", () => {
    const pruned = domain({
      retained: {
        readiness: "ready", minutes: [], minutesTruncated: false,
        curveRemoval: { reason: "age_retention", removedAt: "2026-09-19T00:00:00.000Z" },
        peaks: [domain().retained.peaks[0]],
      },
    });
    useSessionDomain.mockReturnValue(result(pruned));
    render(<ResourcesTab sessionId="claude:resources" historical />);

    expect(screen.getByText(/retention-age setting/)).toBeInTheDocument();
    expect(screen.queryByText(/size threshold/)).not.toBeInTheDocument();
    expect(screen.getByText("Peaks in this window")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /npm run build/ })).toBeInTheDocument();
    expect(screen.queryByText(/\b0(?:\.0+)?%|0 B\/s|0 B\b/)).not.toBeInTheDocument();
  });

  it("never uses age-retention wording for a size cleanup", () => {
    const sizePruned = domain({
      retained: {
        readiness: "ready", minutes: [], minutesTruncated: false,
        curveRemoval: { reason: "size_cleanup", removedAt: "2026-09-19T00:00:00.000Z" },
        peaks: [],
      },
    });
    useSessionDomain.mockReturnValue(result(sizePruned));
    render(<ResourcesTab sessionId="claude:resources" historical />);

    expect(screen.getByText(/size threshold/)).toBeInTheDocument();
    expect(screen.queryByText(/retention-age setting/)).not.toBeInTheDocument();
    expect(screen.getByText("No peaks were recorded for this window.")).toBeInTheDocument();
  });

  it("shows the minute row and fallback text when a peak's full-resolution window was not retained", async () => {
    useSessionDomain.mockReturnValue(result(domain()));
    const user = userEvent.setup();
    render(<ResourcesTab sessionId="claude:resources" historical={false} />);
    await user.click(screen.getByRole("button", { name: "Session" }));

    await user.click(screen.getByRole("button", { name: /611 MiB/ }));
    expect(screen.getByText("Full-resolution window not retained.")).toBeInTheDocument();
    expect(screen.getByText("Min")).toBeInTheDocument();
    expect(screen.getByText("Max")).toBeInTheDocument();
  });

  it("hides the request row when absent and shows the exact wording when a request is linked, with no cost wording", async () => {
    useSessionDomain.mockReturnValue(result(domain()));
    const user = userEvent.setup();
    render(<ResourcesTab sessionId="claude:resources" historical={false} />);
    await user.click(screen.getByRole("button", { name: "Session" }));

    // The default-selected (first) peak has no request association.
    expect(screen.queryByText(/Request observed near this peak/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /611 MiB/ }));
    expect(screen.getByText(/Request observed near this peak · 24 uncached input tokens/)).toBeInTheDocument();
    const zoomPanel = screen.getByRole("region", { name: /^Peak / });
    expect(within(zoomPanel).getByRole("link", { name: "#42" })).toHaveAttribute("href", expect.stringContaining("tab=activities&request=42"));
    expect(screen.queryByText(/request active/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/carried/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/this task cost/i)).not.toBeInTheDocument();
  });

  it("renders loading, unavailable, and rebuilding retained states honestly", () => {
    useSessionDomain.mockReturnValue(result(null));
    const { rerender } = render(<ResourcesTab sessionId="claude:resources" historical={false} />);
    expect(screen.getByText("Loading resource evidence…")).toBeInTheDocument();

    useSessionDomain.mockReturnValue(result(null, null, true));
    rerender(<ResourcesTab sessionId="claude:resources" historical={false} />);
    expect(screen.getByText("Resource evidence is unavailable for this session.")).toBeInTheDocument();

    useSessionDomain.mockReturnValue(result(domain({ retained: { readiness: "loading", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [] } })));
    rerender(<ResourcesTab sessionId="claude:resources" historical />);
    expect(screen.getByText("Loading stored minute aggregates…")).toBeInTheDocument();

    useSessionDomain.mockReturnValue(result(domain({ retained: { readiness: "rebuilding", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [] } })));
    rerender(<ResourcesTab sessionId="claude:resources" historical />);
    expect(screen.getByText("Stored resource history is rebuilding after a restart.")).toBeInTheDocument();

    useSessionDomain.mockReturnValue(result(domain({ retained: { readiness: "unavailable", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [] } })));
    rerender(<ResourcesTab sessionId="claude:resources" historical />);
    expect(screen.getByText("Stored resource history is unavailable.")).toBeInTheDocument();
  });

  it("keeps peak rows keyboard reachable and updates the zoom panel on selection", async () => {
    useSessionDomain.mockReturnValue(result(domain()));
    const user = userEvent.setup();
    render(<ResourcesTab sessionId="claude:resources" historical={false} />);
    await user.click(screen.getByRole("button", { name: "Session" }));

    const cpuRow = screen.getByRole("button", { name: /npm run build/ });
    const memoryRow = screen.getByRole("button", { name: /611 MiB/ });
    expect(cpuRow).toHaveAttribute("aria-pressed", "true");
    expect(memoryRow).toHaveAttribute("aria-pressed", "false");

    memoryRow.focus();
    await user.keyboard("{Enter}");
    expect(memoryRow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Full-resolution window not retained.")).toBeInTheDocument();
  });
});
