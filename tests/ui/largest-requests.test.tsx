import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LargestRequestsList } from "../../app/components/dashboard/requests-actions/LargestRequestsList";
import { scopedRows } from "../../app/components/dashboard/requests-actions/model";
import { compactNumber } from "../../app/dashboard-utils";
import { agent } from "./dashboard-test-fixtures";
import { axisLabels, renderPanel, requestFeed, snapshot, selectedRequest } from "./requests-actions-test-fixtures";

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
    const button = within(region).getByRole("button", { name: "Largest by uncached input" });
    const originalAxis = axisLabels(container);
    const metrics = [
      ["uncached input", 1, "400"],
      ...(cacheWriteAvailable ? [["cache write", 3, "600"]] : []),
      ["total", 4, "900"],
      ["output", 2, "500"],
      ["uncached input", 1, "400"],
    ];
    button.focus();
    for (const [index, [label, number, value]] of metrics.entries()) {
      if (index) await user.keyboard("{Enter}");
      expect(button).toHaveAccessibleName(`Largest by ${label}`);
      expect(button).toHaveFocus();
      const rows = within(region).getAllByRole("button", { name: /^Locate request/ });
      expect(rows[0]).toHaveAccessibleName(`Locate request #${number}, Primary agent, ${value} ${label}`);
      expect(rows[0]).toHaveTextContent(`#${number}Primary agent${value}`);
      expect(selectedRequest()).toBe("#4");
      expect(axisLabels(container)).toEqual(originalAxis);
    }
    await user.click(button);
    await user.click(within(region).getAllByRole("button", { name: /^Locate request/ })[0]);
    expect(selectedRequest()).toBe(cacheWriteAvailable ? "#3" : "#4");
  });

  it("falls back to total if cache-write availability is removed while selected", async () => {
    const user = userEvent.setup();
    const props = { rows: scopedRows(requestFeed(requests), [], "all"), agents: [agent], selectedId: null, onSelect: vi.fn() };
    const { rerender } = render(<LargestRequestsList {...props} cacheWriteAvailable />);
    await user.click(screen.getByRole("button", { name: "Largest by uncached input" }));
    expect(screen.getByRole("button", { name: "Largest by cache write" })).toBeInTheDocument();
    rerender(<LargestRequestsList {...props} cacheWriteAvailable={false} />);
    await user.click(screen.getByRole("button", { name: "Largest by total" }));
    expect(screen.getByRole("button", { name: "Largest by output" })).toBeInTheDocument();
  });

  it("names up to three largest non-zero requests with their agent and selects one on click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const rows = scopedRows(requestFeed(requests), [], "all");
    render(<LargestRequestsList rows={rows} agents={[agent]} selectedId="request-1" cacheWriteAvailable onSelect={onSelect} />);
    const items = within(screen.getByRole("region", { name: "Largest requests" })).getAllByRole("button", { name: /^Locate request/ });
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Locate request #1, Primary agent, 400 uncached input",
      "Locate request #4, Primary agent, 200 uncached input",
    ]);
    expect(items[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/click one/i)).not.toBeInTheDocument();
    expect(items[0].querySelector(".requestsActionsLargestValue")).toHaveAttribute("title", "Uncached input: 400 tokens, this request only");
    await user.click(items[1]);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "request-4" }));
  });

  it("prints the compact request-token format with the exact value in the hover, as the feed does", () => {
    const rows = scopedRows(requestFeed([snapshot(1, "primary", { uncachedInputTokens: 139_670, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 139_670 })]), [], "all");
    render(<LargestRequestsList rows={rows} agents={[agent]} selectedId={null} cacheWriteAvailable onSelect={vi.fn()} />);
    const item = screen.getByRole("button", { name: "Locate request #1, Primary agent, 139,670 uncached input" });
    const value = item.querySelector(".requestsActionsLargestValue")!;
    expect(value).toHaveTextContent(compactNumber(139_670));
    expect(value).not.toHaveTextContent("139,670");
    expect(value).toHaveAttribute("title", "Uncached input: 139,670 tokens, this request only");
  });
});
