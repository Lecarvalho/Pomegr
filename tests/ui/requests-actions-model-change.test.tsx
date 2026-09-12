import { snapshot, renderPanel, setPhone } from "./requests-actions-test-fixtures";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheReadDropFeed } from "../../shared/monitor-contract";

afterEach(() => vi.unstubAllGlobals());

describe("model-change cache evidence", () => {
  it.each([false, true])("explains model-change cache drops without inferring a refill (phone: %s)", async (phone) => {
    setPhone(phone);
    const user = userEvent.setup();
    const target = snapshot(2, "primary", { uncachedInputTokens: 74007, cacheReadTokens: 7168, cacheWriteTokens: 0, outputTokens: 155 });
    const cacheReadDrops: CacheReadDropFeed = { status: "ready", items: [{ agentId: "primary", count: 1, occurrences: [{
      id: "model-drop", kind: "model_change", observedAt: target.observedAt, previousCacheReadPercent: 85.2, cacheReadPercent: 8.8, gapMs: 45529957,
    }] }] };
    const { container } = renderPanel([snapshot(1), target], { cacheWriteAvailable: false, historical: true, cacheReadDrops });
    const bar = screen.getByRole("button", { name: /Request #2,.*Cache reuse dropped across a model change/ });
    fireEvent.keyDown(bar, { key: "Enter" });
    const evidence = screen.getByRole("region", { name: "Request cache evidence" });
    expect(evidence).toHaveTextContent("Cache reuse dropped across a model change");
    expect(evidence).toHaveTextContent("85.2% → 8.8%");
    expect(evidence).toHaveTextContent("A refill and its cause cannot be confirmed.");
    expect(evidence).not.toHaveTextContent(/Inference|Possible refill|Recorded cache-write evidence|Provider diagnostic:/i);
    expect(within(evidence).getByRole("link", { name: /Open signal definition/ })).toHaveAttribute("href", expect.stringContaining("#cache-read-reuse-dropped-model-change"));
    expect(container.querySelector(".requestsActionsMiniRefill")).toBeInTheDocument();
    const label = container.querySelector(".requestsActionsRefillLabel")!;
    expect(label).toHaveTextContent("Reuse drop · model change");
    expect(Number(label.getAttribute("x"))).toBeGreaterThanOrEqual(phone ? 34 : 56);
    expect(Number(label.getAttribute("x")) + (label.textContent?.length ?? 0) * 6).toBeLessThanOrEqual(phone ? 330 : 1100);
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(evidence).toHaveTextContent("Cache reuse dropped across a model change");
    expect(container.querySelector(".requestsActionsRefill title")).toHaveTextContent("Cache reuse dropped across a model change");
  });

});
