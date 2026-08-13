import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import AboutPage from "../../app/about/page";

const styles = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const layoutSource = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");

describe("Pomegr visual contract", () => {
  it("renders the wordmark-only header identity and the product mark on About", () => {
    const { container } = render(<AboutPage />);

    expect(screen.getByRole("link", { name: "Pomegr dashboard" })).toHaveTextContent("Pomegr");
    expect(screen.getByText("ABOUT POMEGR")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pomegr pomegranate mark" })).toHaveAttribute("src", expect.stringContaining("favicon.svg"));
    expect(container.querySelector(".brandMark")).not.toBeInTheDocument();
    expect(layoutSource).toMatch(/icons:\s*\{[\s\S]*?\/favicon\.svg/);
  });

  it("uses restrained typography, persistent chart seeds, translucent areas, and square framed controls", () => {
    expect(styles).not.toMatch(/Georgia|Times New Roman|Arial|Helvetica/);
    expect(styles).toMatch(/\.contextTotalLine\s*\{[^}]*stroke:\s*var\(--brand\)/s);
    expect(styles).toMatch(/:is\(button,[\s\S]*?\)\s*\{\s*border-radius:\s*0;/);
    expect(styles).not.toMatch(/\.activityBars\s*\{[^}]*\bgap\s*:/s);
    expect(styles).toMatch(/\.contextArea\s*\{[^}]*opacity:\s*\.11/);
    expect(styles).toMatch(/\.contextChartPoint\s*\{[^}]*opacity:\s*1/);
    expect(styles).toMatch(/\.contextChartPoint\s*\{[^}]*width:\s*6px;[^}]*height:\s*9px;[^}]*border-radius:\s*65% 45% 60% 48%;[^}]*rotate\(25deg\)/);
    expect(styles).toMatch(/\.panelHeader h2[^}]*font-size:\s*13px/);
    expect(styles).toMatch(/\.ghostButton, \.desktopControls > summary\s*\{[^}]*font-size:\s*11px/);
    expect(styles).toMatch(/\.agentChip, \.pullRequestBadge[^}]*font-size:\s*10px/);
  });
});
