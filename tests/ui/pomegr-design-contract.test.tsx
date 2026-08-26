import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import AboutPage from "../../app/about/page";

const styles = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const layoutSource = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
const contextHistorySource = readFileSync(join(process.cwd(), "app", "components", "dashboard", "ContextHistoryPanel.tsx"), "utf8");
const requestSnapshotsSource = readFileSync(join(process.cwd(), "app", "components", "dashboard", "RequestSnapshotsPanel.tsx"), "utf8");
const sessionProgressSource = readFileSync(join(process.cwd(), "app", "components", "dashboard", "SessionProgressPanel.tsx"), "utf8");

describe("Pomegr visual contract", () => {
  it("renders the wordmark-only header identity and the product mark on About", () => {
    const { container } = render(<AboutPage />);

    expect(screen.getByRole("link", { name: "Pomegr dashboard" })).toHaveTextContent("POMEGR");
    expect(screen.getByText("ABOUT POMEGR")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pomegr pomegranate mark" })).toContainElement(document.querySelector(".aboutBrandMarkImage"));
    expect(document.querySelector(".aboutBrandMarkImage")).toHaveAttribute("src", expect.stringContaining("pomegr-logo.png"));
    expect(container.querySelector(".brandWordmark path")).toBeInTheDocument();
    expect(container.querySelector(".brandMark")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Known issues" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "openai/codex#35300" })).toHaveAttribute("href", "https://github.com/openai/codex/issues/35300");
    expect(layoutSource).toMatch(/icons:\s*\{[\s\S]*?\/pomegr-logo\.png/);
  });

  it("uses restrained typography, a single inspectable context line, and square framed controls", () => {
    expect(styles).not.toMatch(/Georgia|Times New Roman|Arial|Helvetica/);
    expect(styles).toMatch(/:is\(button,[\s\S]*?\)\s*\{\s*border-radius:\s*0;/);
    expect(styles).toMatch(/\.contextHistoryLine\s*\{[^}]*stroke:\s*var\(--blue\);[^}]*stroke-width:\s*2\.25/);
    expect(styles).toMatch(/\.contextBoundary line\s*\{[^}]*stroke-dasharray:\s*3 4/);
    expect(styles).toMatch(/\.contextHistoryChart:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--brand\)/);
    expect(contextHistorySource).toMatch(/role="group"[\s\S]*?tabIndex=\{0\}[\s\S]*?Use Left and Right arrow keys/);
    expect(contextHistorySource).not.toMatch(/role="listitem"[\s\S]*?tabIndex=\{0\}/);
    expect(contextHistorySource).not.toMatch(/ContextGrowthTimeline|cacheReadArea|context added|Cache evidence|cacheEvents/);
    expect(requestSnapshotsSource).toMatch(/role="group"[\s\S]*?tabIndex=\{0\}[\s\S]*?Use Left and Right arrow keys/);
    expect(requestSnapshotsSource).toMatch(/snapshotEventKey\(event\.agentId, event\.observedAt\)/);
    expect(requestSnapshotsSource).toMatch(/className="contextAreaChart requestSnapshotAreaChart"/);
    expect(requestSnapshotsSource).toMatch(/className=\{`contextSeriesLine/);
    expect(requestSnapshotsSource).toMatch(/className=\{`contextChartPoint/);
    expect(requestSnapshotsSource).toMatch(/role="switch"[\s\S]*?aria-checked=\{visibleSeries\[component\.key\]\}/);
    expect(requestSnapshotsSource).not.toMatch(/requestSnapshotBar|requestSnapshotStack|MINIMUM_BAR_STEP/);
    expect(styles).toMatch(/\.requestSnapshotViewport\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto/);
    expect(styles).toMatch(/\.contextSeriesLine\.cacheWriteLine\s*\{\s*stroke:\s*var\(--green\)/);
    expect(styles).toMatch(/\.contextSeriesLine\.cacheReadLine\s*\{\s*stroke:\s*var\(--brand\)/);
    expect(styles).toMatch(/\.contextSeriesLine\s*\{[^}]*stroke-linecap:\s*round;[^}]*stroke-linejoin:\s*round/);
    expect(styles).toMatch(/\.requestSnapshotPoints\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--snapshot-count\), minmax\(0, 1fr\)\)/);
    expect(styles).not.toMatch(/\.requestSnapshotBar|\.requestSnapshotStack/);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.requestSnapshotReadout dl\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(styles).toMatch(/@media \(max-width: 420px\)[\s\S]*?\.requestSnapshotReadout\s*\{\s*margin-left:\s*0/);
    expect(styles).toMatch(/\.panelHeader h2[^}]*font-size:\s*13px/);
    expect(styles).toMatch(/\.ghostButton, \.desktopControls > summary\s*\{[^}]*font-size:\s*11px/);
    expect(styles).toMatch(/\.aboutBack\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*1/);
    expect(styles).toMatch(/\.agentChip, \.pullRequestBadge[^}]*font-size:\s*10px/);
  });

  it("keeps session progress semantic, flat, and motion-safe", () => {
    expect(sessionProgressSource).toMatch(/<progress[^>]*aria-label=\"Agent-reported session progress\"[^>]*aria-valuetext=/);
    expect(sessionProgressSource).toMatch(/Recorded agent estimate/);
    expect(sessionProgressSource).toMatch(/May be stale — later primary-agent activity was observed/);
    expect(styles).toMatch(/\.sessionProgressPanel\s*\{[^}]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.sessionProgressInstrument progress\s*\{[^}]*appearance:\s*none/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\s*\.01ms/);
  });
});
