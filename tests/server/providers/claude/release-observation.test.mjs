import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeCodeReleases, createClaudeCodeReleaseReader } from "../../../../server/providers/claude/release-observation.mjs";

const observedAt = "2026-10-03T12:00:00.000Z";
const release = (tag, extra = {}) => ({ tag_name: tag, html_url: `https://github.com/anthropics/claude-code/releases/tag/${tag}`,
  draft: false, prerelease: false, published_at: "2026-10-02T12:00:00Z", ...extra });
test("Claude release parser accepts official latest publication only", () => {
  assert.deepEqual(parseClaudeCodeReleases([release("v2.1.5")], observedAt), {
    provider: "claude", product: "claude_code", version: "2.1.5", channel: "latest",
    publishedAt: "2026-10-02T12:00:00.000Z", observedAt, sourceKey: "anthropics/claude-code",
  });
  assert.equal(parseClaudeCodeReleases([release("v2.1.6", { prerelease: true })], observedAt), null);
  assert.equal(parseClaudeCodeReleases([release("v2.1.6", { html_url: "https://example.test" })], observedAt), null);
  assert.equal(parseClaudeCodeReleases([release("v2.1.6-beta.1")], observedAt), null);
  assert.equal(parseClaudeCodeReleases(Array(31).fill(release("v2.1.5")), observedAt), null);
});
test("reader rejects redirects, bounds bytes, and retains last good value across failure", async () => {
  let current = 0;
  let at = Date.parse(observedAt);
  const replies = [
    new Response(JSON.stringify([release("v2.1.5")]), { status: 200, headers: { etag: '"release-1"' } }),
    new Response("", { status: 302, headers: { location: "https://other.example" } }),
  ];
  const options = [];
  const read = createClaudeCodeReleaseReader({ now: () => at, fetch: async (_url, request) => { options.push(request); return replies[current++]; } });
  assert.equal((await read()).version, "2.1.5");
  at += 6 * 60 * 60_000;
  assert.equal((await read()).version, "2.1.5");
  assert.equal(options[1].redirect, "error");
  assert.equal(options[1].headers["If-None-Match"], '"release-1"');
  read.stop();
});
test("reader honors Retry-After, rejects oversized bodies, and has a bounded deadline", async () => {
  let at = Date.parse(observedAt);
  let calls = 0;
  const read = createClaudeCodeReleaseReader({ now: () => at, fetch: async () => {
    calls++;
    return calls === 1 ? new Response(null, { status: 429, headers: { "retry-after": "120" } })
      : new Response(JSON.stringify([release("v2.1.5")]));
  } });
  assert.equal(await read(), null);
  at += 119_000;
  assert.equal(await read(), null);
  assert.equal(calls, 1);
  at += 1_000;
  assert.equal((await read()).version, "2.1.5");
  read.stop();
  const oversized = createClaudeCodeReleaseReader({ now: () => at,
    fetch: async () => new Response("x".repeat(1_048_577)) });
  assert.equal(await oversized(), null);
  oversized.stop();
  const timed = createClaudeCodeReleaseReader({ now: () => at, timeoutMs: 5,
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
  assert.equal(await timed(), null);
  timed.stop();
});
