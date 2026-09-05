import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createRepositoryInventoryCaptureHandler } from "../desktop/repository-inventory-action.mjs";
import { createCommittedResponseCache } from "../monitor/committed-response-cache.mjs";
import { createRequestHandler } from "../monitor/request-handler.mjs";
import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";

test("desktop repository capture accepts only trusted bounded targets", async () => {
  let request;
  const handler = createRepositoryInventoryCaptureHandler({
    isTrustedEvent: (event) => event?.trusted === true,
    monitorOrigin: "http://127.0.0.1:4317",
    authorizationToken: "secret",
    fetch: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ status: "completed" })); },
  });
  assert.equal(await handler({ trusted: false }, "repo-0123456789abcdef01234567", "claude"), "unavailable");
  assert.equal(await handler({ trusted: true }, "C:\\private", "claude"), "unavailable");
  assert.equal(await handler({ trusted: true }, "repo-0123456789abcdef01234567", "claude"), "completed");
  assert.match(request.url, /repositoryId=repo-0123456789abcdef01234567/u);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers[DESKTOP_AUTH_HEADER], "secret");
  assert.equal(Object.hasOwn(request.options, "body"), false);
});

test("monitor exposes cache-only repository GETs and protects the capture POST", async (context) => {
  const token = "0123456789abcdef0123456789abcdef";
  const cache = createCommittedResponseCache({ includeRevision: true });
  cache.commit({ readiness: "ready", repositories: [] });
  let captures = 0;
  const server = http.createServer(createRequestHandler({ authorizationToken: token, runtime: {
    serveRepositories: (revision) => cache.read(revision),
    readRepositoryInventory: async () => ({ repositoryId: "repo-0123456789abcdef01234567", provider: "claude", id: "ctx-001" }),
    captureRepositoryInventory: async () => { captures += 1; return "completed"; },
  } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { [DESKTOP_AUTH_HEADER]: token };
  assert.equal((await fetch(`${origin}/api/repositories`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/api/repository-inventory?repositoryId=repo-0123456789abcdef01234567&provider=claude&revisionId=ctx-001`, { headers })).status, 200);
  const captureUrl = `${origin}/internal/repository-inventory/capture?repositoryId=repo-0123456789abcdef01234567&provider=claude`;
  assert.equal((await fetch(captureUrl, { method: "POST" })).status, 401);
  assert.equal((await fetch(captureUrl, { method: "POST", headers: { ...headers, Origin: origin } })).status, 401);
  assert.equal((await fetch(captureUrl, { method: "POST", headers, body: "x" })).status, 400);
  assert.deepEqual(await (await fetch(captureUrl, { method: "POST", headers })).json(), { status: "completed" });
  assert.equal(captures, 1);
});
