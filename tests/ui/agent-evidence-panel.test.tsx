import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEvidencePanel } from "../../app/components/agents/AgentEvidencePanel";

const selection = { title: "Example model", runs: [] };

describe("Agent evidence panel motion lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("keeps closing content mounted but inert until its slide finishes", () => {
    const onClose = vi.fn();
    const view = render(<AgentEvidencePanel selection={selection} onClose={onClose} />);
    const panel = screen.getByRole("dialog", { name: "Example model evidence" });
    expect(screen.getByRole("button", { name: "Close evidence" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<AgentEvidencePanel selection={null} onClose={onClose} />);
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute("data-closing", "true");
    expect(panel).toHaveAttribute("inert");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.transitionEnd(panel.querySelector("h2")!, { propertyName: "transform" });
    expect(panel).toBeInTheDocument();
    fireEvent.transitionEnd(panel, { propertyName: "transform" });
    expect(panel).not.toBeInTheDocument();
  });

  it("reopens the same panel during its exit and cancels old removal", () => {
    const onClose = vi.fn();
    const view = render(<AgentEvidencePanel selection={selection} onClose={onClose} />);
    const panel = screen.getByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<AgentEvidencePanel selection={null} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(80));
    view.rerender(<AgentEvidencePanel selection={{ title: "Another model", runs: [] }} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Another model evidence" })).toBe(panel);
    expect(panel).not.toHaveAttribute("inert");
    expect(panel).not.toHaveAttribute("data-closing");
    act(() => vi.advanceTimersByTime(300));
    expect(panel).toBeInTheDocument();
    view.rerender(<AgentEvidencePanel selection={null} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(240));
    expect(panel).not.toBeInTheDocument();
  });

  it("removes a reduced-motion exit without waiting for a transition", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const view = render(<AgentEvidencePanel selection={selection} onClose={vi.fn()} />);
    const panel = screen.getByRole("dialog");
    view.rerender(<AgentEvidencePanel selection={null} onClose={vi.fn()} />);
    act(() => vi.advanceTimersByTime(0));
    expect(panel).not.toBeInTheDocument();
  });
});
