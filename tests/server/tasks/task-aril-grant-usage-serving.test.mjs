import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";

const TOKEN = "d".repeat(40);
const REPOSITORY = `repo-${"a".repeat(24)}`;

test("grant-next receives the lazy runtime usage resolver", async (t) => {
  const directory = await mkdtemp(path.join(process.cwd(), ".aril-usage-serving-test-"));
  let resolver;
  const store = { nextGrantSteps(options) { resolver = options.resolveUsage; return { ok: true, steps: [] }; } };
  const runtime = { resolveTaskUsage(provider) { return provider === "codex" ? 73 : null; } };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: TOKEN }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/internal/tasks/grant-next",
      headers: { "x-pomegr-desktop-authorization": TOKEN, "content-type": "application/json" } }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end("{}");
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, steps: [] });
  assert.equal(typeof resolver, "function");
  assert.equal(resolver("codex"), 73);
  assert.equal(resolver("claude"), null);
});

test("grant-next preserves only a validated review run override", async (t) => {
  const directory = await mkdtemp(path.join(process.cwd(), ".aril-review-run-serving-test-"));
  const run = { provider: "codex", model: "gpt-6.1-sol", effort: "high" };
  const store = { nextGrantSteps() { return { ok: true, steps: [
    { repositoryId: REPOSITORY, taskId: "T-1", kind: "review", run },
    { repositoryId: REPOSITORY, taskId: "T-2", kind: "start", run },
    { repositoryId: REPOSITORY, taskId: "T-3", kind: "review", run: { ...run, model: "bad model" } },
  ] }; } };
  const server = http.createServer(createRequestHandler({ runtime: {}, taskStore: store, authorizationToken: TOKEN }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/internal/tasks/grant-next",
      headers: { "x-pomegr-desktop-authorization": TOKEN, "content-type": "application/json" } }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end("{}");
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, steps: [{ repositoryId: REPOSITORY, taskId: "T-1", kind: "review", run }] });
});
