import assert from "node:assert/strict";
import test from "node:test";
import { readProviderServiceStatus } from "../monitor/providers/provider-service-status.mjs";

const OPENAI_SUMMARY = "https://status.openai.com/api/v2/summary.json";
const CLAUDE_SUMMARY = "https://status.claude.com/api/v2/summary.json";
const CODEX_API = "01KMP3KP5MGE23B80K1EK4S8PV";
const CODEX_WEB = "01JVCV8YSWZFRSM1G5CVP253SK";
const CLAUDE_CODE = "yyzkbfz2thpt";
const CLAUDE_COWORK = "bpp5gb3hpjcl";
const CLAUDE_AI = "rwppv331jlwc";

function json(value, init = {}) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });
}

function component(id, status = "operational") {
  return { id, status, updated_at: "2026-08-31T12:03:00.000Z", private_description: "RAW_COMPONENT_FIELD_MUST_NOT_LEAK" };
}

function summary(components, extra = {}) {
  return {
    page: { updated_at: "2026-08-31T12:00:00.000Z", private: "RAW_PAGE_FIELD_MUST_NOT_LEAK" },
    components,
    ...extra,
  };
}

function incident({ id = "incident-public-id", name = "Claude Code disruption", status = "investigating", impact = "major", components = [component(CLAUDE_CODE)], url = "https://status.claude.com/incidents/incident-public-id", updated_at = "2026-08-31T12:01:00.000Z", scheduled_for, scheduled_until } = {}) {
  return { id, name, status, impact, components, url, updated_at, scheduled_for, scheduled_until, body: "RAW_INCIDENT_BODY_MUST_NOT_LEAK" };
}

function router(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = responses[url];
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response(options) : response;
    },
  };
}

test("uses the verified Codex summary-only shape when it has no incident collection", async () => {
  const r = router({
    [OPENAI_SUMMARY]: json(summary([component(CODEX_API)])),
  });
  const status = await readProviderServiceStatus("codex", { fetchImpl: r.fetch });

  assert.equal(status.status, "operational");
  assert.equal(status.updatedAt, "2026-08-31T12:03:00.000Z");
  assert.deepEqual(status.incidents, []);
  assert.equal(r.calls.map((call) => call.url).join(","), OPENAI_SUMMARY);
  for (const call of r.calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.redirect, "error");
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test("filters web-only and Cowork-only incidents while admitting Claude Code and authentication incidents", async () => {
  const r = router({
    [OPENAI_SUMMARY]: json(summary([component(CODEX_API), component(CODEX_WEB, "major_outage")])),
    [CLAUDE_SUMMARY]: json(summary([component(CLAUDE_CODE)], {
      incidents: [
        incident({ id: "cowork", name: "Cowork disruption", components: [component(CLAUDE_COWORK)], url: "https://status.claude.com/incidents/cowork" }),
        incident({ id: "code", name: "Claude Code disruption", impact: "minor", components: [component(CLAUDE_CODE)], url: "https://status.claude.com/incidents/code" }),
        incident({ id: "auth", name: "Login authentication disruption", impact: "major", components: [component(CLAUDE_AI)], url: "https://status.claude.com/incidents/auth" }),
      ],
      scheduled_maintenances: [],
    })),
  });
  const codex = await readProviderServiceStatus("codex", { fetchImpl: r.fetch });
  const claude = await readProviderServiceStatus("claude", { fetchImpl: r.fetch });

  assert.equal(codex.status, "operational");
  assert.deepEqual(codex.incidents, []);
  assert.equal(claude.status, "outage");
  assert.deepEqual(claude.incidents.map((item) => item.label).sort(), ["Claude Code disruption", "Login authentication disruption"]);
});

test("omits future scheduled maintenance and recognizes active maintenance", async () => {
  const r = router({
    [CLAUDE_SUMMARY]: json(summary([component(CLAUDE_CODE), component("k8w3r06qmzrp")], {
      incidents: [],
      scheduled_maintenances: [incident({
        id: "maintenance", name: "Claude Code maintenance", status: "scheduled", impact: "none",
        components: [component(CLAUDE_CODE)], scheduled_for: "2099-01-01T00:00:00.000Z", scheduled_until: "2099-01-01T01:00:00.000Z",
      })],
    })),
  });
  const status = await readProviderServiceStatus("claude", { fetchImpl: r.fetch });
  assert.equal(status.status, "operational");
  assert.deepEqual(status.incidents, []);

  const active = await readProviderServiceStatus("claude", { fetchImpl: async () => json(summary([
    component(CLAUDE_CODE), component("k8w3r06qmzrp"),
  ], {
    incidents: [],
    scheduled_maintenances: [incident({
      id: "active-maintenance", name: "Claude Code maintenance", status: "in_progress", impact: "none",
      components: [component(CLAUDE_CODE)],
    })],
  })) });
  assert.equal(active.status, "maintenance");

  const unknown = await readProviderServiceStatus("claude", { fetchImpl: async () => json(summary([component(CLAUDE_COWORK)], {
    incidents: [], scheduled_maintenances: [],
  })) });
  assert.equal(unknown.status, "unknown");
});

test("requires primary component coverage before reporting clean health", async () => {
  const codex = await readProviderServiceStatus("codex", { fetchImpl: async () => json(summary([
    component("01KMKFAMWKQ81YWSE1Z18R6VHR"),
  ])) });
  const claude = await readProviderServiceStatus("claude", { fetchImpl: async () => json(summary([
    component(CLAUDE_CODE),
  ], { incidents: [], scheduled_maintenances: [] })) });
  assert.equal(codex.status, "unknown");
  assert.equal(claude.status, "unknown");
});

test("fails closed for malformed, oversized, redirected, failed, and cancelled public reads", async () => {
  const controller = new AbortController();
  controller.abort();
  const cases = [
    () => readProviderServiceStatus("unknown", { fetchImpl: async () => { throw Error("not reached"); } }),
    () => readProviderServiceStatus("codex", { fetchImpl: async () => json({ page: {}, components: "not-an-array" }) }),
    () => readProviderServiceStatus("codex", { fetchImpl: async () => json(summary([component(CODEX_API), component(CODEX_API)])) }),
    () => readProviderServiceStatus("codex", { fetchImpl: async () => json(summary([component(CODEX_API)], { incidents: [{ name: "Incomplete issue" }] })) }),
    () => readProviderServiceStatus("claude", { fetchImpl: async () => json(summary([component(CLAUDE_CODE)])) }),
    () => readProviderServiceStatus("codex", { fetchImpl: async () => new Response("private", { status: 302 }) }),
    () => readProviderServiceStatus("codex", { fetchImpl: async () => { throw Error("PRIVATE_NETWORK_DETAILS_MUST_NOT_LEAK"); } }),
    () => readProviderServiceStatus("codex", { signal: controller.signal, fetchImpl: async (_url, options) => {
      assert.equal(options.signal.aborted, true); throw new DOMException("PRIVATE_CANCEL_DETAILS_MUST_NOT_LEAK", "AbortError");
    } }),
    () => readProviderServiceStatus("codex", { fetchImpl: async () => new Response(" ".repeat(256 * 1024 + 1)) }),
  ];
  for (const read of cases) await assert.rejects(read, { message: "Provider service status unavailable." });
});

test("bounds incident output and strips unsafe fields and non-official URLs", async () => {
  const incidents = Array.from({ length: 12 }, (_, index) => incident({
    id: `id-${index}`, name: `Incident ${index} <script>`, impact: index === 0 ? "critical" : "minor",
    url: index === 11 ? "https://evil.example/incidents/11?token=PRIVATE" : `https://status.claude.com/incidents/${index}?raw=PRIVATE`,
    updated_at: `2026-08-31T12:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const r = router({
    [CLAUDE_SUMMARY]: json(summary([component(CLAUDE_CODE)], { incidents, scheduled_maintenances: [] })),
  });
  const status = await readProviderServiceStatus("claude", { fetchImpl: r.fetch });
  const serialized = JSON.stringify(status);
  assert.equal(status.status, "outage");
  assert.equal(status.incidents.length, 8);
  assert.doesNotMatch(serialized, /RAW_(?:PAGE|COMPONENT|INCIDENT)_FIELD_MUST_NOT_LEAK|PRIVATE|script|evil\.example/);
  assert.equal(status.incidents.every((item) => item.url.startsWith("https://status.claude.com/") && !item.url.includes("?")), true);
});
