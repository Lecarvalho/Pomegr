import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionHistoryStore } from "../../../../server/sessions/history/session-history-store.mjs";

const request = (id, observedAt) => ({
  id: `request-${id}`, agentId: "primary", observedAt, cacheLifetime: null,
  uncachedInputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4, totalTokens: 10,
  precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null,
});

for (const storage of ["memory", "disk index", "block store"]) {
  test(`request lookup fills the chart window at history boundaries (${storage})`, async (t) => {
    const directory = storage === "memory" ? null : await mkdtemp(path.join(os.tmpdir(), "pomegr-history-window-"));
    if (directory) t.after(() => rm(directory, { recursive: true, force: true }));
    const sessionId = "codex:request-window";
    const requests = Array.from({ length: 263 }, (_, index) => ({
      ...request(index.toString(16).padStart(16, "0"), new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString()),
      agentId: index % 2 === 0 ? "primary" : "child",
    }));
    const store = new SessionHistoryStore({ directory });
    if (storage === "block store") {
      await store.publishRequestContribution(sessionId, { epoch: 1, sequence: 1, requests, activity: [] });
    } else {
      await store.publish(sessionId, { requests, activity: [], complete: true });
    }
    const reader = directory ? new SessionHistoryStore({ directory }) : store;
    for (const scope of ["all", "primary"]) {
      const scoped = requests.filter((item) => scope === "all" || item.agentId === scope);
      for (const limit of [20, 60]) {
        for (const position of [0, Math.floor(scoped.length / 2), scoped.length - 2, scoped.length - 1]) {
          const page = await reader.read(sessionId, { kind: "requests", scope, limit: String(limit), requestId: scoped[position].id });
          const offset = Math.max(0, Math.min(position - Math.floor(limit / 2), scoped.length - limit));
          assert.equal(page.offset, offset);
          assert.deepEqual(page.items.map((item) => item.id), scoped.slice(offset, offset + limit).map((item) => item.id));
        }
      }
    }
  });
}

