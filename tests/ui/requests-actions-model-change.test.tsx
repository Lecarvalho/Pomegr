import { snapshot, renderPanel, selectedRequest, setPhone } from "./requests-actions-test-fixtures";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheReadDropFeed } from "../../shared/monitor-contract";

afterEach(() => vi.unstubAllGlobals());

describe("model-change cache evidence", () => {
  it.each([false, true])("labels model-change cache drops without inferring a refill (phone: %s)", async (phone) => {
    setPhone(phone);
    const user = userEvent.setup();
    const target = snapshot(2, "primary", { uncachedInputTokens: 74007, cacheReadTokens: 7168, cacheWriteTokens: 0, outputTokens: 155 });
    const cacheReadDrops: CacheReadDropFeed = { status: "ready", items: [{ agentId: "primary", count: 1, occurrences: [{
      id: "model-drop", kind: "model_change", observedAt: target.observedAt, previousCacheReadPercent: 85.2, cacheReadPercent: 8.8, gapMs: 45529957,
    }] }] };
    const { container } = renderPanel([snapshot(1), target], { cacheWriteAvailable: false, historical: true, cacheReadDrops });
    const bar = screen.getByRole("button", { name: /Request #2,.*Cache reuse dropped across a model change/ });
    expect(bar.getAttribute("aria-label")).not.toMatch(/Inference|Possible refill|Possible full refill/i);
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(selectedRequest()).toBe("#2");
    expect(container.querySelector(".requestsActionsMiniRefill")).toBeInTheDocument();
    const label = container.querySelector(".requestsActionsRefillLabel")!;
    expect(label).toHaveTextContent("Reuse drop · model change");
    expect(Number(label.getAttribute("x"))).toBeGreaterThanOrEqual(phone ? 34 : 8);
    expect(Number(label.getAttribute("x")) + (label.textContent?.length ?? 0) * 6).toBeLessThanOrEqual(phone ? 330 : 1104);
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(selectedRequest()).toBe("#2");
    expect(container.querySelector(".requestsActionsRefill title")).toHaveTextContent("Cache reuse dropped across a model change");
  });

});
