import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/agents/route";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Agents same-origin proxy", () => {
  it("forwards only selection and revision to the fixed loopback endpoint", async () => {
    vi.stubEnv("POMEGR_MONITOR_ORIGIN", "http://127.0.0.1:4317");
    vi.stubEnv("POMEGR_MONITOR_TOKEN", "private-monitor-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"revision":7}', { headers: { "x-pomegr-revision": "7" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await GET(new Request("http://localhost:3003/api/agents?project=Pomegr&days=7&scope=delegated&revision=6&url=https://evil.example&sourcePath=PRIVATE_PATH"));
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4317/api/agents?project=Pomegr&days=7&scope=delegated&revision=6", expect.objectContaining({
      cache: "no-store", headers: { "x-pomegr-desktop-authorization": "private-monitor-token" },
    }));
    expect(result.headers.get("x-pomegr-revision")).toBe("7");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.text()).not.toMatch(/PRIVATE_PATH|private-monitor-token|evil/);
  });

  it("preserves a revision-only 204 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const result = await GET(new Request("http://localhost:3003/api/agents?revision=7"));
    expect(result.status).toBe(204);
    expect(await result.text()).toBe("");
  });

  it("bounds selectors and sanitizes upstream failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("PRIVATE_CREDENTIAL_FAILURE"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await GET(new Request("http://localhost:3003/api/agents?project=%0APrivate&days=999&scope=unsafe&revision=99999999999999999999"));
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/agents\?project=all&days=30&scope=all$/);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ readiness: "unavailable", generatedAt: null, error: "Agent summary is unavailable." });
    await GET(new Request("http://localhost:3003/api/agents?revision=" + "0".repeat(10_000)));
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/agents\?project=all&days=30&scope=all$/);
  });
});
