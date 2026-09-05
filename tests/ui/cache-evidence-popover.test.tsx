import fs from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheEvidencePopover } from "../../app/components/dashboard/CacheEvidencePopover";

const rect = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height, right: left + width, bottom: top + height,
  x: left, y: top, toJSON: () => ({}),
});

function Harness({ onClose }: { onClose: () => void }) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  return <div className="rosterRow">
    <span ref={anchorRef} className="cache-anchor">Trigger</span>
    <CacheEvidencePopover anchorRef={anchorRef} id="cache-evidence" ariaLabel="Cache evidence" eyebrow="Cache" title="Possible refill" closeLabel="Close" onClose={onClose} summary="Summary">
      <div>Evidence</div>
    </CacheEvidencePopover>
  </div>;
}

describe("CacheEvidencePopover", () => {
  let geometry: ReturnType<typeof vi.spyOn>;
  let resizeCallback: (() => void) | undefined;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
    geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("cache-anchor")) return rect(420, 180, 20, 20);
      if (this.classList.contains("rosterRow")) return rect(100, 160, 900, 40);
      if (this.classList.contains("agentPopover")) return rect(0, 0, 300, 240);
      return rect(0, 0, 0, 0);
    });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resizeCallback = callback; }
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    geometry.mockRestore();
    vi.unstubAllGlobals();
    resizeCallback = undefined;
  });

  it("positions from the trigger rect and portals outside the roster row", async () => {
    render(<Harness onClose={vi.fn()} />);
    const surface = await screen.findByRole("dialog", { name: "Cache evidence" });
    expect(surface.parentElement).toBe(document.body);
    expect(surface).toHaveStyle({ left: "420px", top: "208px", visibility: "visible" });
    expect(surface.closest(".rosterRow")).toBeNull();
  });

  it("clamps to viewport edges and flips above when below does not fit", async () => {
    geometry.mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("cache-anchor")) return rect(1160, 740, 20, 20);
      if (this.classList.contains("agentPopover")) return rect(0, 0, 300, 240);
      return rect(0, 0, 900, 64);
    });
    render(<Harness onClose={vi.fn()} />);
    const surface = await screen.findByRole("dialog", { name: "Cache evidence" });
    expect(surface).toHaveStyle({ left: "888px", top: "492px" });
  });

  it("uses the row origin on mobile while retaining the viewport clamp", async () => {
    window.innerWidth = 640;
    geometry.mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("cache-anchor")) return rect(580, 180, 20, 20);
      if (this.classList.contains("rosterRow")) return rect(24, 160, 600, 56);
      if (this.classList.contains("agentPopover")) return rect(0, 0, 300, 240);
      return rect(0, 0, 0, 0);
    });
    render(<Harness onClose={vi.fn()} />);
    expect(await screen.findByRole("dialog", { name: "Cache evidence" })).toHaveStyle({ left: "24px" });
  });

  it("recalculates on resize, scroll, and observed geometry changes", async () => {
    render(<Harness onClose={vi.fn()} />);
    const surface = await screen.findByRole("dialog", { name: "Cache evidence" });
    geometry.mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("cache-anchor")) return rect(200, 300, 20, 20);
      if (this.classList.contains("agentPopover")) return rect(0, 0, 300, 240);
      return rect(0, 0, 900, 64);
    });
    act(() => { fireEvent(window, new Event("resize")); });
    expect(surface).toHaveStyle({ left: "200px", top: "328px" });
    geometry.mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("cache-anchor")) return rect(260, 300, 20, 20);
      if (this.classList.contains("agentPopover")) return rect(0, 0, 300, 240);
      return rect(0, 0, 900, 64);
    });
    act(() => { fireEvent.scroll(window); resizeCallback?.(); });
    expect(surface).toHaveStyle({ left: "260px" });
  });

  it("keeps open for inside pointer input and closes for outside input or Escape", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const surface = await screen.findByRole("dialog", { name: "Cache evidence" });
    fireEvent.pointerDown(surface);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("cleans up global listeners on unmount", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Harness onClose={vi.fn()} />);
    await screen.findByRole("dialog", { name: "Cache evidence" });
    unmount();
    expect(remove).toHaveBeenCalledWith("pointerdown", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("wheel", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    remove.mockRestore();
    removeWindow.mockRestore();
  });

  it("keeps desktop evidence labels content-sized with subgrid rows and mobile width safeguards", () => {
    const workspace = fs.readFileSync(path.join(process.cwd(), "app", "styles", "workspace.css"), "utf8");
    const evidence = fs.readFileSync(path.join(process.cwd(), "app", "styles", "evidence.css"), "utf8");
    expect(workspace).toContain(".cacheRefillEvidenceGrid { grid-template-columns: max-content minmax(0, 1fr); column-gap: var(--space-3); }");
    expect(workspace).toContain(".cacheRefillEvidenceGrid > div { grid-column: 1 / -1; grid-template-columns: subgrid; column-gap: inherit; }");
    expect(workspace).toContain("@media (max-width: 640px) { .cacheRefillPopover { width: calc(100vw - 54px); } }");
    expect(evidence).not.toContain(".agentRow");
  });
});
