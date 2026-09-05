import { describe, expect, it } from "vitest";
import type { CacheLifetime, RequestSnapshot, RequestSnapshotFeed } from "../../shared/monitor-contract";
import { deriveAgentTurnCacheEvidence } from "../../app/components/dashboard/AgentTurnCacheTiming";

function request(id: string, observedAt: string, cacheLifetime: CacheLifetime | null, cacheReadTokens = 0, cacheWriteTokens = 0): RequestSnapshot {
  const uncachedInputTokens = 10;
  const outputTokens = 5;
  return {
    id,
    agentId: "primary",
    observedAt,
    cacheLifetime,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens: uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    precedingWork: [],
    precedingAssociation: null,
    issuedWork: [],
    issuedAssociation: null,
  };
}

function feed(items: RequestSnapshot[]): RequestSnapshotFeed {
  return { status: "ready", items };
}

describe("agent turn and cache timing evidence", () => {
  it("keeps the newest request separate from the newest request with cache activity", () => {
    const evidence = deriveAgentTurnCacheEvidence(feed([
      request("touch", "2026-08-08T12:00:00.000Z", "5m", 200),
      request("turn", "2026-08-08T12:04:30.000Z", null),
    ]), "primary", Date.parse("2026-08-08T12:04:30.000Z"), false, "active");

    expect(evidence.lastRequest?.id).toBe("turn");
    expect(evidence.lastCacheTouch?.id).toBe("touch");
    expect(evidence.state).toBe("near");
  });

  it("marks only resolved five-minute and one-hour touches as elapsed", () => {
    expect(deriveAgentTurnCacheEvidence(feed([
      request("five", "2026-08-08T12:00:00.000Z", "5m", 0, 200),
    ]), "primary", Date.parse("2026-08-08T12:05:00.000Z"), false, "active").state).toBe("elapsed");

    expect(deriveAgentTurnCacheEvidence(feed([
      request("hour", "2026-08-08T12:00:00.000Z", "1h", 200),
    ]), "primary", Date.parse("2026-08-08T13:00:00.000Z"), false, "active").state).toBe("elapsed");

    expect(deriveAgentTurnCacheEvidence(feed([
      request("mixed", "2026-08-08T12:00:00.000Z", "mixed", 200),
    ]), "primary", Date.parse("2026-08-08T14:00:00.000Z"), false, "active").state).toBe("unavailable");
  });

  it("does not apply a live warning to historical or unavailable evidence", () => {
    const requests = feed([request("touch", "2026-08-08T12:00:00.000Z", "5m", 200)]);
    expect(deriveAgentTurnCacheEvidence(requests, "primary", Date.parse("2026-08-08T13:00:00.000Z"), true, "active").state).toBe("neutral");
    expect(deriveAgentTurnCacheEvidence({ status: "unavailable", items: requests.items }, "primary", Date.parse("2026-08-08T13:00:00.000Z"), false, "active")).toEqual({
      lastRequest: null,
      lastCacheTouch: null,
      state: "unavailable",
    });
  });

  it("never turns a documented minimum into a nearing or elapsed warning", () => {
    const requests = feed([request("minimum", "2026-08-08T12:00:00.000Z", "30m+", 200)]);
    for (const minutes of [29, 30, 31, 25 * 60]) {
      const now = Date.parse("2026-08-08T12:00:00.000Z") + minutes * 60_000;
      expect(deriveAgentTurnCacheEvidence(requests, "primary", now, false, "active").state).toBe("unavailable");
    }
  });

  it.each(["finished", "stopped"] as const)("suppresses live cache warnings for %s agents while retaining recorded timing", (status) => {
    const requests = feed([
      request("touch", "2026-08-08T12:00:00.000Z", "5m", 200),
    ]);
    const evidence = deriveAgentTurnCacheEvidence(requests, "primary", Date.parse("2026-08-08T12:04:30.000Z"), false, status);

    expect(evidence.lastRequest?.observedAt).toBe("2026-08-08T12:00:00.000Z");
    expect(evidence.lastCacheTouch?.observedAt).toBe("2026-08-08T12:00:00.000Z");
    expect(evidence.state).toBe("neutral");
    expect(deriveAgentTurnCacheEvidence(requests, "primary", Date.parse("2026-08-08T12:05:00.000Z"), false, status).state).toBe("neutral");
  });

  it("restores live warnings when a terminal agent status becomes active again", () => {
    const requests = feed([request("touch", "2026-08-08T12:00:00.000Z", "5m", 200)]);
    const now = Date.parse("2026-08-08T12:04:30.000Z");

    expect(deriveAgentTurnCacheEvidence(requests, "primary", now, false, "stopped").state).toBe("neutral");
    expect(deriveAgentTurnCacheEvidence(requests, "primary", now, false, "active").state).toBe("near");
  });
});
