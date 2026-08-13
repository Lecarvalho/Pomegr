import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import AboutPage from "../../app/about/page";

const styles = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

describe("Pomegr visual contract", () => {
  it("renders the wordmark-only identity and updated About eyebrow", () => {
    const { container } = render(<AboutPage />);

    expect(screen.getByRole("link", { name: "Pomegr dashboard" })).toHaveTextContent("Pomegr");
    expect(screen.getByText("ABOUT POMEGR")).toBeInTheDocument();
    expect(container.querySelector(".brandMark")).not.toBeInTheDocument();
  });

  it("uses Inter roles, tokenized chart color, square architecture, and readable labels", () => {
    expect(styles).not.toMatch(/Georgia|Times New Roman|Arial|Helvetica/);
    expect(styles).toMatch(/\.contextTotalLine\s*\{[^}]*stroke:\s*var\(--brand\)/s);
    expect(styles).toMatch(/:is\(button,[\s\S]*?\)\s*\{\s*border-radius:\s*0;/);
    expect(styles).not.toMatch(/\.activityBars\s*\{[^}]*\bgap\s*:/s);
    expect(styles).toMatch(/\.agentChip\s*\{\s*min-height:\s*20px;\s*line-height:\s*14px;/);
    expect(styles).toMatch(/\.agentChip\s*\{\s*font-size:\s*11px;/);
  });
});
