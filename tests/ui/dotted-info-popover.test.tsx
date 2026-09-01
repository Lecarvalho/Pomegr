import fs from "node:fs";
import path from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DottedInfoPopover } from "../../app/components/DottedInfoPopover";
import { CACHE_TIMING_DOCUMENTATION_URL } from "../../app/components/dashboard/AgentTurnCacheTiming";

describe("DottedInfoPopover", () => {
  it("opens factual content from its dotted trigger and supports keyboard dismissal", async () => {
    const user = userEvent.setup();
    render(<DottedInfoPopover ariaLabel="Term details" content={<span>Recorded fact</span>}>term</DottedInfoPopover>);

    const trigger = screen.getByRole("button", { name: "Term details" });
    expect(trigger).toHaveClass("dottedInfoPopoverTrigger");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.querySelector(".dottedInfoPopoverLabel")).toHaveTextContent("term");

    await user.tab();
    expect(screen.getByRole("dialog", { name: "Term details" })).toHaveTextContent("Recorded fact");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Term details" })).not.toBeInTheDocument();
  });

  it("keeps the optional documentation link interactive", () => {
    render(<DottedInfoPopover
      ariaLabel="Cache details"
      content={<span>Cache fact</span>}
      link={{ href: "https://example.test/cache", label: "How cache works", ariaLabel: "Open cache documentation" }}
    >cache</DottedInfoPopover>);

    const trigger = screen.getByRole("button", { name: "Cache details" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    const link = screen.getByRole("link", { name: "Open cache documentation; opens in a new tab" });
    expect(link).toHaveAttribute("href", "https://example.test/cache");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("keeps the cache-timing link aligned with its canonical documentation page", () => {
    expect(CACHE_TIMING_DOCUMENTATION_URL).toBe("https://github.com/Lecarvalho/pomegr/blob/main/docs/CACHE_TIMING.md");
    expect(fs.readFileSync(path.join(process.cwd(), "docs", "CACHE_TIMING.md"), "utf8")).toContain("# Cache timing");
  });
});
