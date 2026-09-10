import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LargestRequestsList } from "../../app/components/dashboard/requests-actions/LargestRequestsList";
import { scopedRows } from "../../app/components/dashboard/requests-actions/model";
import { axisLabels, renderPanel, requestFeed, snapshot } from "./requests-actions-test-fixtures";

const requests = [
  snapshot(1, "primary", { uncachedInputTokens: 400, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 400 }),
  snapshot(2, "primary", { uncachedInputTokens: 0, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 500 }),
  snapshot(3, "primary", { uncachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 600, cacheReadTokens: 0, totalTokens: 600 }),
  snapshot(4, "primary", { uncachedInputTokens: 200, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 700, totalTokens: 900 }),
];

describe("Largest requests metric control", () => {
  it.each([true, false])("cycles supported metrics without moving selection or the chart (cache write: %s)", async (cacheWriteAvailable) => {
    const user = userEvent.setup();
    const { container } = renderPanel(requests, { cacheWriteAvailable });
    const region = screen.getByRole("region", { name: "Largest requests" });
    const button = within(region).getByRole("button", { name: "by uncached input" });
    const originalAxis = axisLabels(container);
    const metrics = [
      ["uncached input", 1, "400"],
      ["output", 2, "500"],
      ...(cacheWriteAvailable ? [["cache write", 3, "600"]] : []),
      ["total", 4, "900"],
      ["uncached input", 1, "400"],
    ];
    button.focus();
    for (const [index, [label, number, value]] of metrics.entries()) {
      if (index) await user.keyboard("{Enter}");
      expect(button).toHaveAccessibleName(`by ${label}`);
      expect(button).toHaveFocus();
      const rows = within(region).getAllByRole("button", { name: /^Locate request/ });
      expect(rows[0]).toHaveAccessibleName(`Locate request #${number}, ${value} ${label}`);
      expect(rows[0].lastElementChild).toHaveTextContent(String(value));
      expect(rows[0].querySelector("i")).toHaveStyle({ width: "100%" });
      expect(screen.getByRole("heading", { name: "Request #4" })).toBeInTheDocument();
      expect(axisLabels(container)).toEqual(originalAxis);
    }
    await user.click(button);
    await user.click(within(region).getAllByRole("button", { name: /^Locate request/ })[0]);
    expect(screen.getByRole("heading", { name: "Request #2" })).toBeInTheDocument();
  });

  it("falls back to total if cache-write availability is removed while selected", async () => {
    const user = userEvent.setup();
    const props = { rows: scopedRows(requestFeed(requests), [], "all"), scopeLabel: "All agents", selectedId: null, onSelect: vi.fn() };
    const { rerender } = render(<LargestRequestsList {...props} cacheWriteAvailable />);
    await user.click(screen.getByRole("button", { name: "by uncached input" }));
    await user.click(screen.getByRole("button", { name: "by output" }));
    expect(screen.getByRole("button", { name: "by cache write" })).toBeInTheDocument();
    rerender(<LargestRequestsList {...props} cacheWriteAvailable={false} />);
    await user.click(screen.getByRole("button", { name: "by total" }));
    expect(screen.getByRole("button", { name: "by uncached input" })).toBeInTheDocument();
  });
});
