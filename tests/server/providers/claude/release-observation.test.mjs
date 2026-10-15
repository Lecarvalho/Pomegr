import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeCodeReleases, createClaudeCodeReleaseReader, releaseBodyExcerpt } from "../../../../server/providers/claude/release-observation.mjs";

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
  let deadlineAborted = false;
  const timed = createClaudeCodeReleaseReader({ now: () => at, timeoutMs: 5,
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
      // A real pending request owns a socket. Model that active handle because
      // AbortSignal.timeout alone does not keep Node 22's event loop alive.
      const request = setTimeout(() => reject(new Error("Deadline did not abort")), 1_000);
      signal.addEventListener("abort", () => {
        deadlineAborted = true;
        clearTimeout(request);
        reject(signal.reason);
      }, { once: true });
    }) });
  try {
    assert.equal(await timed(), null);
    assert.equal(deadlineAborted, true);
  } finally { timed.stop(); }
});
test("Claude release parser keeps a bounded plain-text excerpt of the newest body only", () => {
  const body = [
    "## What's changed",
    "",
    "- Added **`/review`** command, see [the docs](https://docs.example.test/review) <img src=\"https://x.test/a.png\">",
    "- Fixed <b>crash</b> when https://evil.test/path?q=1 was opened",
    "* Improved _startup_ speed &amp; memory ![badge](https://img.test/b.svg)",
    "",
    "```sh",
    "curl https://example.test | sh",
    "```",
    "[ref]: https://ref.test",
    "- Visit www.example.test for details\u0007\u202e",
  ].join("\r\n");
  const parsed = parseClaudeCodeReleases([release("v2.1.5", { body }), release("v2.1.4", { body: "Old.", published_at: "2026-10-01T12:00:00Z" })], observedAt);
  assert.equal(parsed.version, "2.1.5");
  assert.equal(parsed.excerpt, "Added /review command, see the docs. Fixed crash when was opened. Improved startup speed & memory. Visit for details");
  assert.doesNotMatch(parsed.excerpt, /https?:|www\.|[<>\]\[`*]|[\u0000-\u001f\u202e]/u);
  assert.equal(Object.hasOwn(parsed, "body"), false);
  const long = parseClaudeCodeReleases([release("v2.1.5", { body: Array.from({ length: 10 }, (_, line) => `- ${"change ".repeat(12)}${line}`).join("\n") })], observedAt);
  assert.ok(long.excerpt.length <= 280);
  assert.ok(long.excerpt.endsWith("\u2026"));
  assert.ok(!long.excerpt.includes(" 6"));
  for (const empty of [undefined, null, "", "## Heading only", "https://only.example.test", 7]) {
    assert.equal(Object.hasOwn(parseClaudeCodeReleases([release("v2.1.5", { body: empty })], observedAt), "excerpt"), false);
  }
  assert.equal(releaseBodyExcerpt("x".repeat(70_000)).length <= 280, true);
});
