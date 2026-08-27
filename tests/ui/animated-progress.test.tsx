import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimatedProgressBar, useAnimatedProgressValue } from "../../app/components/AnimatedProgress";

function ProgressHarness({ value, motion = "detail", animate = true }: { value: number; motion?: "detail" | "compact"; animate?: boolean }) {
  const displayed = useAnimatedProgressValue(value, motion, animate);
  return <>
    <output data-testid="displayed-progress">{Math.round(displayed)}</output>
    <AnimatedProgressBar
      value={value}
      displayedValue={displayed}
      label="Agent-reported session progress"
      valueText={`${value}% complete`}
      motion={motion}
    />
  </>;
}

function installAnimationFrame() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextId;
    callbacks.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => callbacks.delete(id)));

  return (timestamp: number) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    act(() => pending.forEach((callback) => callback(timestamp)));
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("animated progress", () => {
  it("renders the first reported value immediately without an entrance animation", () => {
    installAnimationFrame();
    render(<ProgressHarness value={42} />);

    expect(screen.getByTestId("displayed-progress")).toHaveTextContent("42");
    expect(screen.getByRole("progressbar")).toHaveValue(42);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("moves the visual value progressively while exposing the new semantic value immediately", () => {
    const step = installAnimationFrame();
    const { rerender } = render(<ProgressHarness value={24} />);

    rerender(<ProgressHarness value={78} />);
    expect(screen.getByRole("progressbar")).toHaveValue(78);
    expect(screen.getByTestId("displayed-progress")).toHaveTextContent("24");

    step(0);
    step(160);
    const intermediate = Number(screen.getByTestId("displayed-progress").textContent);
    expect(intermediate).toBeGreaterThan(24);
    expect(intermediate).toBeLessThan(78);

    step(1_000);
    expect(screen.getByTestId("displayed-progress")).toHaveTextContent("78");
  });

  it("supports backward revisions and retargets from the in-flight visual value", () => {
    const step = installAnimationFrame();
    const { rerender } = render(<ProgressHarness value={82} />);

    rerender(<ProgressHarness value={30} />);
    step(0);
    step(150);
    const decreasing = Number(screen.getByTestId("displayed-progress").textContent);
    expect(decreasing).toBeLessThan(82);
    expect(decreasing).toBeGreaterThan(30);

    rerender(<ProgressHarness value={60} />);
    step(200);
    expect(Number(screen.getByTestId("displayed-progress").textContent)).toBeCloseTo(decreasing, 0);
    step(800);
    expect(screen.getByTestId("displayed-progress")).toHaveTextContent("60");
  });

  it("jumps directly to revisions when reduced motion is requested", () => {
    installAnimationFrame();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { rerender } = render(<ProgressHarness value={35} motion="compact" />);

    rerender(<ProgressHarness value={70} motion="compact" />);

    expect(screen.getByTestId("displayed-progress")).toHaveTextContent("70");
    expect(screen.getByRole("progressbar")).toHaveValue(70);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
