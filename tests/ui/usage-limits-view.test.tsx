import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsageLimitsView } from "../../app/components/command-center/CommandViews";

vi.mock("../../app/usage-limits-client", () => ({
  useUsageLimits: () => ({
    revision: null,
    generatedAt: null,
    providers: [],
    readiness: { claude: "loading", codex: "loading" },
  }),
}));

describe("usage limits view", () => {
  it("shows automatic observation state without an inactive manual refresh action", () => {
    const { container } = render(<UsageLimitsView />);

    expect(screen.getByRole("heading", { name: "Usage limits", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Usage limits are loading")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh limits" })).not.toBeInTheDocument();
    expect(container.querySelector(".commandViewActions")).not.toBeInTheDocument();
  });
});
