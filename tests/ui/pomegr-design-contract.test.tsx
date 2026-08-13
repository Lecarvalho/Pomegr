import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import AboutPage from "../../app/about/page";

const styles = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const layoutSource = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
const timelineSource = readFileSync(join(process.cwd(), "app", "components", "dashboard", "ContextGrowthTimeline.tsx"), "utf8");

describe("Pomegr visual contract", () => {
  it("renders the wordmark-only header identity and the product mark on About", () => {
    const { container } = render(<AboutPage />);

    expect(screen.getByRole("link", { name: "Pomegr dashboard" })).toHaveTextContent("POMEGR");
    expect(screen.getByText("ABOUT POMEGR")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pomegr pomegranate mark" })).toContainElement(document.querySelector(".aboutBrandMarkLight"));
    expect(document.querySelector(".aboutBrandMarkDark")).toHaveAttribute("src", expect.stringContaining("pomegr-mark-outline-dark.svg"));
    expect(document.querySelector(".aboutBrandMarkLight")).toHaveAttribute("src", expect.stringContaining("pomegr-mark-outline-light.svg"));
    expect(container.querySelector(".brandWordmark path")).toBeInTheDocument();
    expect(container.querySelector(".brandMark")).not.toBeInTheDocument();
    expect(layoutSource).toMatch(/icons:\s*\{[\s\S]*?\/favicon\.svg/);
  });

  it("uses restrained typography, persistent chart seeds, translucent areas, and square framed controls", () => {
    expect(styles).not.toMatch(/Georgia|Times New Roman|Arial|Helvetica/);
    expect(styles).toMatch(/--chart-area-rose:\s*#994238/);
    expect(styles).toMatch(/--chart-line-rose:\s*#87372f/);
    expect(styles).toMatch(/--chart-fill-strength:\s*11%/);
    expect(styles).toMatch(/html\[data-theme="dark"\][\s\S]*?--chart-area-rose:\s*#972b46;[\s\S]*?--chart-line-rose:\s*#e0607d;[\s\S]*?--chart-fill-strength:\s*22%/);
    expect(styles).toMatch(/\.cacheReadArea\s*\{\s*fill:\s*color-mix\(in srgb,\s*var\(--chart-area-rose\)\s*var\(--chart-fill-strength\),\s*var\(--panel\)\)/);
    expect(styles).toMatch(/\.contextTotalLine\s*\{[^}]*stroke:\s*var\(--chart-line-rose\)/s);
    expect(styles).toMatch(/\.cacheReadSwatch\s*\{\s*background:\s*var\(--chart-area-rose\)/);
    expect(styles).toMatch(/:is\(button,[\s\S]*?\)\s*\{\s*border-radius:\s*0;/);
    expect(styles).not.toMatch(/\.activityBars\s*\{[^}]*\bgap\s*:/s);
    expect(styles).toMatch(/\.contextArea\s*\{[^}]*opacity:\s*1/);
    expect(styles).toMatch(/\.contextChartPoint\s*\{[^}]*opacity:\s*1/);
    expect(styles).toMatch(/\.contextChartPoint\s*\{[^}]*width:\s*11px;[^}]*height:\s*9px;[^}]*transform:\s*translate\(-50%, -50%\)/);
    expect(styles).toMatch(/\.contextChartPoint circle\s*\{[^}]*stroke-width:\s*1\.7;[^}]*vector-effect:\s*non-scaling-stroke/);
    expect(styles).toMatch(/\.activityBar:hover \.contextChartPoint,[^}]*scale\(1\.57\)/);
    expect(styles).not.toMatch(/\.contextChartPoint\s*\{[^}]*rotate\(/);
    expect(timelineSource).toMatch(/viewBox="0 0 8\.7 8\.7" preserveAspectRatio="none"[\s\S]*?<circle cx="4\.35" cy="4\.35" r="3\.5"/);
    expect(styles).toMatch(/\.panelHeader h2[^}]*font-size:\s*13px/);
    expect(styles).toMatch(/\.ghostButton, \.desktopControls > summary\s*\{[^}]*font-size:\s*11px/);
    expect(styles).toMatch(/\.agentChip, \.pullRequestBadge[^}]*font-size:\s*10px/);
  });
});
