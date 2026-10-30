import { readFileSync } from "node:fs";
import { act, fireEvent, render, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AgentGridSection } from "../../app/components/design-system/DesignSystemAgentGridSample";
import { RepositorySetupSection } from "../../app/components/design-system/DesignSystemRepositorySamples";
import { sample, sectionOf } from "./design-system-helpers";

const styles = ["agent-grid", "workspace"].map((name) => readFileSync("app/styles/" + name + ".css", "utf8")).join("\n");

describe("Static grid and repository samples", () => {
  let fetchSpy: MockInstance;
  let storageRead: MockInstance;
  let storageWrite: MockInstance;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Sample network use is forbidden"));
    storageRead = vi.spyOn(Storage.prototype, "getItem");
    storageWrite = vi.spyOn(Storage.prototype, "setItem");
  });
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageRead).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it("renders agent grid tile states and all three metrics without changing the static selection", () => {
    render(<AgentGridSection />);
    const section = sectionOf("Agent grid tile states");
    for (const [label, metric] of [["Latest context", "context"], ["Wall time", "wall"], ["Tool calls", "toolCalls"]]) {
      const frame = sample(section, label);
      expect(frame.querySelector(`.agentGridMetric-${metric}`)).not.toBeNull();
      expect(within(frame).getByRole("button", { name: label, pressed: true })).toBeInTheDocument();
      expect(frame.querySelector(".agentGridLane > header")).toHaveTextContent("Direct subagents");
      expect(frame.querySelectorAll(".agentGridTileMetrics")).toHaveLength(6);
      for (const status of ["finished", "idle", "active", "stopped"]) {
        expect(frame.querySelector(`.agentGridStatus-${status}`)).not.toBeNull();
      }
      expect(frame.querySelector(".agentGridWarning")).toHaveAttribute("title", expect.stringContaining("warning signal"));
      const selected = within(frame).getByRole("button", { name: "Select Selected tile", pressed: true });
      expect(selected.closest(".agentRosterPanel")).not.toBeNull();
      expect(selected).toHaveClass("agentGridSelected");
      expect(selected.querySelector(".agentGridBar")).toHaveStyle({ width: "100%" });
      const firstBar = within(frame).getByRole("button", { name: "Select Finished tile" }).querySelector<HTMLElement>(".agentGridBar")!;
      expect(parseFloat(firstBar.style.width)).toBeCloseTo(100 / 6);
      fireEvent.click(within(frame).getByRole("button", { name: "Select Idle tile" }));
      expect(selected).toHaveAttribute("aria-pressed", "true");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders repository setup row states with inert actions, feedback, and capture confirmation", () => {
    render(<RepositorySetupSection />);
    const section = sectionOf("Repository setup row states");
    const update = sample(section, "Update available");
    expect(update.querySelector(".commandSettingRow.repositoryRow")).not.toBeNull();
    expect(update.querySelector(".repositoryUpdateAvailable")).toHaveTextContent("v1.1.0 available");
    expect(within(update).getByRole("button", { name: "Update plugin" })).toHaveClass("commandPrimaryAction");
    expect(within(update).getByRole("button", { name: "Recheck" })).toHaveClass("commandQuietAction");
    for (const tone of ["pending", "success", "neutral", "error"]) {
      expect(section.querySelector(`.repositorySetupFeedback.${tone}`)).toHaveAttribute("role", "status");
    }
    for (const [label, chip, tone] of [["Current", "r1 saved", "info"], ["Unavailable", "Unavailable", "neutral"], ["Not captured", "Not captured", "neutral"], ["Capturing", "Capturing", "warning"], ["Failed", "Failed", "negative"]]) {
      const frame = sample(section, label);
      expect(frame.querySelector(".commandChip")).toHaveTextContent(chip);
      expect(frame.querySelector(".commandChip")).toHaveClass(tone);
    }
    expect(within(sample(section, "Current")).getByRole("button", { name: "Capture again" })).toHaveClass("commandSecondaryAction");
    expect(within(sample(section, "Capturing")).getByRole("button", { name: "Capture inventory" })).toBeDisabled();
    expect(within(sample(section, "Failed")).getByRole("button", { name: "Retry diagnostic" })).toBeEnabled();
    expect(section.querySelector(".repositorySectionHead .providerBadge")).toHaveTextContent("Claude Code");
    expect(section.querySelector(".repositoryChecked")).toHaveTextContent("Captured 25 Oct 2026, 12:00 UTC");
    const confirm = within(section).getByRole("group", { name: "Confirm Claude Code inventory capture" });
    expect(confirm).toHaveClass("repositoryCaptureConfirm");
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveClass("commandSecondaryAction");
    expect(within(confirm).getByRole("button", { name: "Run diagnostic" })).toHaveClass("commandPrimaryAction");
    for (const button of within(section).getAllByRole("button")) fireEvent.click(button);
    expect(confirm).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("documents repository setup states using the shared feedback and confirmation styles", () => {
    expect(styles).toMatch(/\.repositorySetupFeedback\.error\s*\{[^}]*var\(--color-error\)/);
    expect(styles).toMatch(/\.repositorySetupFeedback\.success\s*\{[^}]*var\(--command-green\)/);
    expect(styles).toMatch(/\.repositoryCaptureConfirm\s*\{[^}]*var\(--command-line-strong\)/);
    expect(styles).toMatch(/\.repositorySectionHead\s*\{[^}]*var\(--command-muted\)/);
  });
  it("documents the static grid matrix using the shipped tile states and metric tokens", () => {
    expect(styles).toMatch(/\.agentGridStatus-idle[^}]*border-style: dashed/);
    expect(styles).toMatch(/\.agentGridStatus-active\s*\{[^}]*var\(--command-green\)/);
    expect(styles).toMatch(/\.agentGridStatus-stopped\s*\{[^}]*var\(--red\)/);
    expect(styles).toMatch(/\.agentGridWarning\s*\{[^}]*var\(--command-amber\)/);
    expect(styles).toMatch(/\.agentRosterPanel \.agentGridTile\.agentGridSelected\s*\{[^}]*var\(--command-brand-text\)/);
    expect(styles).toMatch(/\.agentGridMetric-wall\s*\{[^}]*var\(--command-green\)/);
    expect(styles).toMatch(/\.agentGridMetric-toolCalls\s*\{[^}]*var\(--command-muted\)/);
  });
  it("hydrates fixed markup across time zones without reading stores or native actions", async () => {
    const samples = <><AgentGridSection /><RepositorySetupSection /></>;
    vi.stubEnv("TZ", "UTC");
    const html = renderToString(samples);
    vi.stubEnv("TZ", "Pacific/Honolulu");
    expect(renderToString(samples)).toBe(html);
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(renderToString(samples)).toBe(html);
    const container = document.body.appendChild(document.createElement("div"));
    container.innerHTML = html;
    const recoverable = vi.fn();
    const root = await act(async () => hydrateRoot(container, samples, { onRecoverableError: recoverable }));
    expect(recoverable).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });
});
