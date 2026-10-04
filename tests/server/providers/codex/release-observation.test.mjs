import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexCliRelease, createCodexCliReleaseReader } from "../../../../server/providers/codex/release-observation.mjs";

const release = (tag, extra = {}) => ({ tag_name: tag, assets: [], ...extra });
test("Codex official latest channel selects CLI tags only, excluding desktop, IDE and alpha", () => {
  const row = parseCodexCliRelease(release("rust-v0.8.0"), "2026-10-03T12:00:00.000Z");
  assert.equal(row.product, "codex_cli");
  assert.equal(row.version, "0.8.0");
  assert.equal(row.channel, "latest");
  assert.equal(parseCodexCliRelease(release("rust-v0.9.0-alpha.1"), "2026-10-03T12:00:00.000Z"), null);
  assert.equal(parseCodexCliRelease(release("app-v1.2.3"), "2026-10-03T12:00:00.000Z"), null);
  assert.equal(parseCodexCliRelease(release("rust-v0.9.0", { assets: Array(257).fill({}) }), "2026-10-03T12:00:00.000Z"), null);
});
test("Codex reader pins OpenAI's installer channel metadata", async () => {
  let requested;
  const read = createCodexCliReleaseReader({ now: () => Date.parse("2026-10-03T12:00:00.000Z"),
    fetch: async (url, options) => { requested = { url, options }; return new Response(JSON.stringify(release("rust-v0.8.0"))); } });
  assert.equal((await read()).version, "0.8.0");
  assert.equal(requested.url, "https://releases.openai.com/codex/channels/latest");
  assert.equal(requested.options.redirect, "error");
});
