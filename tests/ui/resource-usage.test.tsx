import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MonitorState } from "../../shared/monitor-contract";
import { ResourceUsagePanel } from "../../app/components/dashboard/ResourceUsagePanel";

describe("live resource usage panel", () => {
  const gibibyte = 1024 ** 3;
  const mebibyte = 1024 ** 2;
  const readyResources = {
    status: "ready",
    reason: null,
    current: {
      cpuCores: 1.75,
      cpuMachinePercent: 10.94,
      memoryBytes: 3 * gibibyte,
      readBytesPerSecond: 2 * mebibyte,
      writeBytesPerSecond: mebibyte,
    },
    observedPeak: { memoryBytes: 4.25 * gibibyte },
    samples: [
      { timestamp: "2026-08-14T12:00:00.000Z", cpuCores: 0.5, cpuMachinePercent: 3.1, memoryBytes: 2 * gibibyte, readBytesPerSecond: 0, writeBytesPerSecond: 256 * 1024 },
      { timestamp: "2026-08-14T12:01:00.000Z", cpuCores: null, cpuMachinePercent: null, memoryBytes: 2.5 * gibibyte, readBytesPerSecond: null, writeBytesPerSecond: null },
      { timestamp: "2026-08-14T12:02:00.000Z", cpuCores: 1.75, cpuMachinePercent: 10.94, memoryBytes: 3 * gibibyte, readBytesPerSecond: 2 * mebibyte, writeBytesPerSecond: mebibyte },
    ],
  } satisfies NonNullable<MonitorState["metrics"]["resources"]>;

  it("renders current values, observed memory peak, and separate read/write telemetry", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    const { container } = render(<ResourceUsagePanel resources={readyResources} />);

    expect(container.querySelector(".disclosureSummaryMetrics")).not.toBeInTheDocument();
    expect(screen.getAllByText("11%")).toHaveLength(2);
    expect(screen.getByText("Overall share across all logical processors")).toBeInTheDocument();
    expect(screen.getAllByText("3.0 GiB")).toHaveLength(2);
    expect(screen.getByText("Observed peak 4.3 GiB")).toBeInTheDocument();
    expect(screen.getAllByText("3.0 MiB/s")).toHaveLength(1);
    expect(screen.getByText(/2.0 MiB\/s read/)).toHaveTextContent(/1.0 MiB\/s write/);
    expect(screen.getAllByText("Read")).toHaveLength(2);
    expect(screen.getAllByText("Write")).toHaveLength(2);
  });

  it("keeps sampling frequency and measurement age out of the interface", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    render(<ResourceUsagePanel resources={readyResources} />);

    expect(screen.queryByText(/measured|sampled|sampling frequency|every \d|\d+s ago/i)).not.toBeInTheDocument();
  });

  it("shows explicit collecting and unavailable states without fabricated zeroes", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    const { rerender } = render(<ResourceUsagePanel resources={{
      status: "collecting",
      reason: null,
      current: null,
      observedPeak: null,
      samples: [],
    }} />);

    expect(screen.getByRole("status")).toHaveTextContent("Collecting resource samples");
    expect(screen.queryByText(/\b0(?:\.0+)?%|0 B\/s/)).not.toBeInTheDocument();

    rerender(<ResourceUsagePanel resources={{
      status: "unavailable",
      reason: "shared_owner",
      current: null,
      observedPeak: null,
      samples: [],
    }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Resource use unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("shares a process owner");
    expect(screen.queryByText(/\b0(?:\.0+)?%|0 B\/s/)).not.toBeInTheDocument();
  });

  it("starts open, stores collapse preference, and restores it on remount", async () => {
    window.localStorage.removeItem("pomegr-resource-panel-open");
    const user = userEvent.setup();
    const { container, unmount } = render(<ResourceUsagePanel resources={readyResources} />);
    const disclosure = container.querySelector("details.resourceUsagePanel");

    expect(disclosure).toHaveAttribute("open");
    expect(disclosure?.querySelector(".disclosureSummaryMetrics")).not.toBeInTheDocument();
    await user.click(screen.getByText("Resource use"));
    expect(disclosure).not.toHaveAttribute("open");
    const compactSummary = disclosure?.querySelector(".disclosureSummaryMetrics");
    expect(compactSummary).toHaveTextContent("CPU 11%");
    expect(compactSummary).toHaveTextContent("Memory 3.0 GiB");
    expect(compactSummary).toHaveTextContent("I/O 3.0 MiB/s");
    expect(window.localStorage.getItem("pomegr-resource-panel-open")).toBe("false");

    unmount();
    const restored = render(<ResourceUsagePanel resources={readyResources} />).container.querySelector("details.resourceUsagePanel");
    expect(restored).not.toHaveAttribute("open");
    expect(restored?.querySelector(".disclosureSummaryMetrics")).toHaveTextContent("CPU 11%");
  });

  it("retains disclosure changes in memory when preference storage rejects writes", async () => {
    window.localStorage.removeItem("pomegr-resource-panel-open");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    });
    const user = userEvent.setup();
    const first = render(<ResourceUsagePanel resources={readyResources} />);

    expect(first.container.querySelector("details.resourceUsagePanel")).toHaveAttribute("open");
    await user.click(screen.getByText("Resource use"));
    expect(first.container.querySelector("details.resourceUsagePanel")).not.toHaveAttribute("open");

    first.unmount();
    const restored = render(<ResourceUsagePanel resources={readyResources} />);
    expect(restored.container.querySelector("details.resourceUsagePanel")).not.toHaveAttribute("open");
    setItem.mockRestore();
  });

  it("uses one chart tab stop and navigates all lanes with arrow keys", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    const { container } = render(<ResourceUsagePanel resources={readyResources} />);
    const charts = screen.getByRole("group", { name: /Resource use over the last 15 minutes/ });
    const announcement = container.querySelector(".resourceChartAnnouncement");
    const readout = container.querySelector(".resourceChartReadout");

    expect(charts).toHaveAttribute("tabindex", "0");
    expect(charts.querySelectorAll("[tabindex]")).toHaveLength(0);
    expect(announcement).toHaveTextContent("CPU 11% overall across all logical processors");
    expect(readout).toHaveTextContent("CPU 11%");
    expect(readout?.querySelector("time")).toHaveAttribute("dateTime", "2026-08-14T12:02:00.000Z");

    fireEvent.keyDown(charts, { key: "ArrowLeft" });
    expect(announcement).toHaveTextContent("CPU Unavailable");
    expect(announcement).toHaveTextContent("Memory 2.5 GiB");
    expect(readout).toHaveTextContent("CPU Unavailable");
    expect(readout).toHaveTextContent("Memory 2.5 GiB");

    fireEvent.keyDown(charts, { key: "Home" });
    expect(announcement).toHaveTextContent("CPU 3.1% overall across all logical processors");

    fireEvent.keyDown(charts, { key: "End" });
    expect(announcement).toHaveTextContent("CPU 11% overall across all logical processors");
  });

  it("synchronizes the visible chart readout to pointer position", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    const { container } = render(<ResourceUsagePanel resources={readyResources} />);
    const charts = screen.getByRole("group", { name: /Resource use over the last 15 minutes/ });
    const readout = container.querySelector(".resourceChartReadout");
    const cpuChart = container.querySelector<SVGSVGElement>(".resourceChartSvg")!;
    vi.spyOn(cpuChart, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 300,
      top: 0,
      width: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerMove(cpuChart, { clientX: 0 });
    expect(readout).toHaveTextContent("CPU 3.1%");
    expect(readout?.querySelector("time")).toHaveAttribute("dateTime", "2026-08-14T12:00:00.000Z");

    fireEvent.pointerLeave(charts);
    expect(readout).toHaveTextContent("CPU 11%");
  });

  it("renders finite straight paths and gaps missing measurements", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    const { container } = render(<ResourceUsagePanel resources={readyResources} />);
    const paths = [...container.querySelectorAll<SVGPathElement>(".resourceChartLine")];

    expect(paths).toHaveLength(4);
    for (const path of paths) {
      expect(path.getAttribute("d")).not.toMatch(/NaN|Infinity/);
    }
    expect(container.querySelector(".resourceCpuLine")?.getAttribute("d")?.match(/\bM\b/g)).toHaveLength(2);
    expect(container.querySelector(".resourceReadLine")?.getAttribute("d")?.match(/\bM\b/g)).toHaveLength(2);
    expect(container.querySelector(".resourceWriteLine")?.getAttribute("d")?.match(/\bM\b/g)).toHaveLength(2);
  });
});
