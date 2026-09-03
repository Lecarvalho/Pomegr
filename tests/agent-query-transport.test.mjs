import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_QUERY_AUTH_HEADER,
  AGENT_QUERY_DESCRIPTOR_VERSION,
  AGENT_QUERY_MAX_RESPONSE_BYTES,
  createAgentQueryCapability,
  fetchAgentQuery,
  normalizeAgentQueryDescriptor,
  publishAgentQueryDescriptor,
  readAgentQueryDescriptor,
  removeAgentQueryDescriptorIfTokenMatches,
  resolveAgentQueryDescriptorPath,
} from "../shared/agent-query-transport.mjs";

const TOKEN = "A".repeat(43);

test("agent query capability is a distinct 256-bit base64url token", () => {
  const token = createAgentQueryCapability((size) => Buffer.alloc(size, 7));
  assert.equal(token, Buffer.alloc(32, 7).toString("base64url"));
  assert.equal(token.length, 43);
  assert.equal(AGENT_QUERY_AUTH_HEADER, "x-pomegr-agent-authorization");
});

test("runtime descriptor is normalized to the bounded loopback contract", () => {
  assert.deepEqual(normalizeAgentQueryDescriptor({ version: 1, origin: "http://127.0.0.1:4317", token: TOKEN }), {
    version: AGENT_QUERY_DESCRIPTOR_VERSION,
    origin: "http://127.0.0.1:4317",
    token: TOKEN,
  });
  for (const value of [
    null,
    { version: 2, origin: "http://127.0.0.1:4317", token: TOKEN },
    { version: 1, origin: "https://127.0.0.1:4317", token: TOKEN },
    { version: 1, origin: "http://10.0.0.1:4317", token: TOKEN },
    { version: 1, origin: "http://127.0.0.1:4317", token: "short" },
    { version: 1, origin: "http://127.0.0.1:4317", token: TOKEN, secret: "leak" },
  ]) assert.equal(normalizeAgentQueryDescriptor(value), null);
});

test("descriptor publication is atomic, bounded, and cleanup is token conditional", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-agent-query-"));
  const descriptorPath = resolveAgentQueryDescriptorPath(root);
  try {
    const descriptor = await publishAgentQueryDescriptor({ descriptorPath, origin: "http://127.0.0.1:4567", token: TOKEN });
    assert.deepEqual(descriptor, { version: 1, origin: "http://127.0.0.1:4567", token: TOKEN });
    assert.deepEqual(await readAgentQueryDescriptor({ descriptorPath }), descriptor);
    assert.ok((await stat(descriptorPath)).isFile());
    const serialized = await readFile(descriptorPath, "utf8");
    assert.match(serialized, /agent-query-runtime|127\.0\.0\.1/);
    assert.doesNotMatch(serialized, /SECRET|prompt|response/);
    assert.equal(await removeAgentQueryDescriptorIfTokenMatches({ descriptorPath, token: "B".repeat(43) }), false);
    assert.deepEqual(await readAgentQueryDescriptor({ descriptorPath }), descriptor);
    assert.equal(await removeAgentQueryDescriptorIfTokenMatches({ descriptorPath, token: TOKEN }), true);
    assert.equal(await readAgentQueryDescriptor({ descriptorPath }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent query client uses descriptor token, rejects redirects, and bounds response bodies", async () => {
  const calls = [];
  const result = await fetchAgentQuery("/api/agent/v1/provider-health", {
    descriptorPath: "C:\\missing\\agent-query-runtime.json",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  assert.equal(result.body.ok, true);
  assert.equal(calls[0].url, "http://127.0.0.1:4317/api/agent/v1/provider-health");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(Object.hasOwn(calls[0].options.headers, AGENT_QUERY_AUTH_HEADER), false);

  const tooLarge = await fetchAgentQuery("/api/agent/v1/provider-health", {
    descriptorPath: "C:\\missing\\agent-query-runtime.json",
    fetchFn: async () => new Response("x".repeat(AGENT_QUERY_MAX_RESPONSE_BYTES + 1), { status: 200 }),
  });
  assert.equal(tooLarge.error, "monitor_unavailable");
  assert.equal(tooLarge.body, null);

  const timedOut = await fetchAgentQuery("/api/agent/v1/provider-health", {
    descriptorPath: "C:\\missing\\agent-query-runtime.json",
    timeoutMs: 1,
    fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  assert.equal(timedOut.error, "monitor_unavailable");

  let requested = false;
  const invalidDescriptor = await fetchAgentQuery("/api/agent/v1/provider-health", {
    descriptorPath: "C:\\invalid\\agent-query-runtime.json",
    statFn: async () => ({ isFile: () => true, size: 2 }),
    readFileFn: async () => "{}",
    fetchFn: async () => { requested = true; return new Response("{}"); },
  });
  assert.equal(invalidDescriptor.error, "monitor_unavailable");
  assert.equal(requested, false, "an invalid crash descriptor must not fall back to dev monitor");
});
