import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createCodexAppServerModelCatalogReader, CODEX_MODEL_LIST_UNAVAILABLE } from "../../../../server/providers/codex/app-server-client.mjs";
import { createCodexModelObservation, createOpenAIModelAnnouncementReader, normalizeCodexModelCatalog,
  parseOpenAIModelNews } from "../../../../server/providers/codex/model-observation.mjs";

const row = (id, overrides = {}) => ({ id, model: id, displayName: id, hidden: false, ...overrides });
const page = (data, nextCursor = null) => ({ data, nextCursor });
const scope = "a".repeat(64);

function child() {
  const value = new EventEmitter();
  value.exitCode = null;
  value.signalCode = null;
  value.stdout = new EventEmitter();
  value.stderr = new EventEmitter();
  value.stdin = new EventEmitter();
  value.stdin.writable = true;
  value.stdin.destroyed = false;
  value.stdin.end = () => { value.stdin.ended = true; };
  value.stdin.write = () => true;
  value.kill = (signal) => { value.signalCode = signal; value.emit("exit", null, signal); return true; };
  return value;
}

function catalogReader(responses, requests, config = {}) {
  const version = child();
  version.start = () => queueMicrotask(() => {
    version.stdout.emit("data", "codex-cli 0.144.1\n");
    version.exitCode = 0;
    version.emit("exit", 0, null);
  });
  const server = child();
  server.stdin.write = (data) => {
    const request = JSON.parse(String(data));
    requests.push(request);
    if (request.id === 1) queueMicrotask(() => server.stdout.emit("data", '{"id":1,"result":{}}\n'));
    if (request.method === "model/list") queueMicrotask(() => {
      const result = responses.shift();
      server.stdout.emit("data", `${JSON.stringify({ id: request.id, result })}\n`);
    });
    return true;
  };
  const children = [version, server];
  const reader = createCodexAppServerModelCatalogReader({ resolveExecutable: () => "C:\\tools\\codex.exe",
    env: config.env,
    spawnFn: (_command, args, options) => {
      config.spawnCalls?.push(options);
      assert.ok(["--version", "app-server"].includes(args[0]));
      const next = children.shift();
      next?.start?.();
      return next;
    }, timeoutMs: 100 });
  return { reader, server };
}

test("model/list uses one short-lived child, complete bounded pagination, and only read methods", async () => {
  const requests = [];
  const { reader, server } = catalogReader([page([row("gpt-6-sol")], "cursor-2"), page([row("gpt-6-astra")])], requests);
  const snapshot = await reader.readCatalog();
  assert.deepEqual(snapshot.pages.map((part) => part.data[0].id), ["gpt-6-sol", "gpt-6-astra"]);
  assert.deepEqual(requests.map(({ method }) => method), ["initialize", "initialized", "model/list", "model/list"]);
  assert.deepEqual(requests.filter(({ method }) => method === "model/list").map(({ params }) => params), [
    { limit: 32, cursor: null, includeHidden: true },
    { limit: 32, cursor: "cursor-2", includeHidden: true },
  ]);
  assert.equal(server.stdin.ended, true);
  assert.equal(server.signalCode, "SIGTERM");
});

test("configured effective Codex home reaches both transient child launches", async () => {
  const spawnCalls = [];
  const env = { PATH: "C:\\tools", CODEX_HOME: "C:\\isolated-codex-home" };
  const { reader } = catalogReader([page([row("gpt-6-sol")])], [], { env, spawnCalls });
  await reader.readCatalog();
  assert.deepEqual(spawnCalls.map((call) => call.env), [env, env]);
});

test("partial, cyclic, and oversized pagination fails as a whole without committing a page", async () => {
  for (const responses of [
    [page([row("gpt-6")], "same"), page([row("gpt-6.1")], "same")],
    [page([row("gpt-6")], "a"), page([row("gpt-6.1")], "b"), page([row("gpt-6.2")], "c"), page([row("gpt-6.3")], "d")],
    [page(Array.from({ length: 33 }, (_, n) => row(`gpt-6-${n}`)))],
  ]) {
    const { reader, server } = catalogReader(responses, []);
    await assert.rejects(reader.readCatalog(), new RegExp(CODEX_MODEL_LIST_UNAVAILABLE));
    assert.equal(server.stdin.ended, true);
    assert.equal(server.signalCode, "SIGTERM");
  }
});

test("whole snapshot validation excludes hidden and aliases, retains known identities, and rejects malformed rows", () => {
  assert.deepEqual(normalizeCodexModelCatalog({ pages: [page([
    row("gpt-6-sol"), row("gpt-6-early", { hidden: true }),
    row("gpt-6-alias", { model: "gpt-6-sol" }),
  ])] }), { models: [{ id: "gpt-6-sol", label: "gpt-6-sol" }],
    knownIds: ["gpt-6-sol", "gpt-6-early", "gpt-6-alias"] });
  for (const bad of [row("gpt-6", { hidden: "false" }), row("gpt-6", { displayName: "<script>" }),
    row("gpt-6", { id: "../gpt-6" }), row("gpt-6", { model: 4 })]) {
    assert.equal(normalizeCodexModelCatalog({ pages: [page([row("gpt-5"), bad])] }), null);
  }
  assert.equal(normalizeCodexModelCatalog({ pages: [page([row("gpt-5"), row("gpt-5")])] }), null);
  assert.equal(normalizeCodexModelCatalog({ pages: [page([row("gpt-5")], "unfetched")] }), null);
});

test("observer retains original last good during failure, clears on source switch, and never claims entitlement", async () => {
  let time = Date.parse("2026-10-03T10:00:00.000Z");
  let currentScope = scope;
  let calls = 0;
  const observer = createCodexModelObservation({ now: () => time, sourceScope: () => currentScope,
    catalogReader: { async readCatalog() {
      calls++;
      if (calls > 1) throw new Error("PRIVATE_DETAILS");
      return { pages: [page([row("gpt-6-sol")])] };
    } } });
  const first = await observer.read();
  assert.deepEqual(first.models, [{ id: "gpt-6-sol", label: "gpt-6-sol" }]);
  assert.equal(first.observedAt, "2026-10-03T10:00:00.000Z");
  time += 60 * 60_000 + 1;
  assert.deepEqual(await observer.read(), first);
  assert.equal(calls, 2);
  currentScope = "b".repeat(64);
  assert.deepEqual(await observer.read(), { provider: "codex", status: "unavailable", complete: false,
    observedAt: null, sourceScope: null, models: [], knownIds: [] });
  assert.equal(observer.capabilities.accountEntitlement, "unavailable");
});

const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>OpenAI News</title>${items.join("")}</channel></rss>`;
const rssItem = (title, date = "Fri, 02 Oct 2026 14:00:00 GMT", link = "https://openai.com/index/introducing-gpt-6-sol/") =>
  `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${date}</pubDate><description>PRIVATE_BODY</description></item>`;

test("official RSS recognizes only exact model announcement and retirement headlines", () => {
  const rows = parseOpenAIModelNews(rss([
    rssItem("Introducing GPT-6 Sol"),
    rssItem("Retiring GPT-5 Mini", "Thu, 01 Oct 2026 14:00:00 GMT", "https://openai.com/index/retiring-gpt-5-mini/"),
    rssItem("Introducing ChatGPT for Teams"),
    rssItem("GPT-6 Astra: a new generation"),
  ]), "2026-10-03T10:00:00.000Z");
  assert.deepEqual(rows, [
    { modelId: "gpt-6-sol", label: "GPT-6 Sol", kind: "announced", publishedAt: "2026-10-02T14:00:00.000Z" },
    { modelId: "gpt-5-mini", label: "GPT-5 Mini", kind: "deprecated", publishedAt: "2026-10-01T14:00:00.000Z" },
  ]);
  assert.equal(JSON.stringify(rows).includes("PRIVATE_BODY"), false);
  for (const invalid of [rss([rssItem("Introducing GPT-6 Sol", undefined, "https://evil.example/index/gpt-6/")]),
    rss([rssItem("Introducing GPT-6 Sol", "Fri, 02 Oct 2026 14:00:00 GMT"), rssItem("Introducing GPT-6 Sol")]),
    rss([rssItem("Introducing GPT-6 Sol", "Fri, 02 Oct 2027 14:00:00 GMT")]),
    `<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]>${rss([])}`]) {
    assert.equal(parseOpenAIModelNews(invalid, "2026-10-03T10:00:00.000Z"), null);
  }
});

test("official RSS reader fixes origin, rejects redirects and oversized bodies, preserves original observation", async () => {
  let time = Date.parse("2026-10-03T10:00:00.000Z");
  let requests = 0;
  const xml = rss([rssItem("Introducing GPT-6 Sol")]);
  const reader = createOpenAIModelAnnouncementReader({ now: () => time,
    fetch: async (url, options) => {
      requests++;
      assert.equal(url, "https://openai.com/news/rss.xml");
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      if (requests === 1) return new Response(xml, { status: 200, headers: { etag: '"v1"', "content-type": "text/xml; charset=utf-8" } });
      return new Response(null, { status: 304 });
    } });
  const first = await reader.read();
  assert.equal(first.status, "ready");
  assert.equal(first.complete, true);
  assert.equal(first.announcements[0].kind, "announced");
  time += 6 * 60 * 60_000 + 1;
  assert.deepEqual(await reader.read(), first);
  assert.equal(requests, 2);
  reader.stop();

  const blocked = createOpenAIModelAnnouncementReader({ now: () => time,
    fetch: async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200, headers: { "content-type": "text/xml" } }) });
  assert.equal((await blocked.read()).status, "unavailable");
});

test("official RSS reader deadline and stop settle fetches that ignore abort", async () => {
  const never = () => new Promise(() => {});
  const deadlineReader = createOpenAIModelAnnouncementReader({ fetch: never, timeoutMs: 10 });
  assert.equal((await deadlineReader.read()).status, "unavailable");
  const stoppedReader = createOpenAIModelAnnouncementReader({ fetch: never, timeoutMs: 8_000 });
  const pending = stoppedReader.read();
  stoppedReader.stop();
  assert.equal((await pending).status, "unavailable");
});
