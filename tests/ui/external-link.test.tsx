import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExternalLink } from "../../app/components/ExternalLink";

describe("ExternalLink", () => {
  it("opens a new context with a fixed visual and accessible indication", () => {
    const { container } = render(<ExternalLink href="https://example.test/docs">Read documentation</ExternalLink>);
    const link = screen.getByRole("link", { name: "Read documentation (opens in a new tab)" });

    expect(link).toHaveAttribute("href", "https://example.test/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("extends an explicit accessible label with the context change", () => {
    render(<ExternalLink href="https://example.test/docs" aria-label="Open documentation">Documentation</ExternalLink>);
    expect(screen.getByRole("link", { name: "Open documentation; opens in a new tab" })).toBeInTheDocument();
  });
});
