import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/provider-status/route";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("provider status same-origin proxy", () => {
  it("forwards only a numeric revision and monitor authorization, never supplied URLs or session data", async () => {
    vi.stubEnv("POMEGR_MONITOR_ORIGIN", "http://127.0.0.1:4317");
    vi.stubEnv("POMEGR_MONITOR_TOKEN", "private-monitor-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"revision":7,"providers":[]}', {
      headers: { "x-pomegr-revision": "7" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new Request("http://localhost:3003/api/provider-status?revision=6&url=https://evil.example&sessionId=private-session"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4317/api/provider-status?revision=6", expect.objectContaining({
      cache: "no-store", headers: { "x-pomegr-desktop-authorization": "private-monitor-token" },
    }));
    expect(response.headers.get("x-pomegr-revision")).toBe("7");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toMatch(/private-monitor-token|private-session|evil/);
  });

  it("preserves 204 without inventing a replacement body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const response = await GET(new Request("http://localhost:3003/api/provider-status?revision=7"));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("sanitizes errors and invalid revisions into unavailable provider rows", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("PRIVATE_FAILURE_WITH_CREDENTIALS"));
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new Request("http://localhost:3003/api/provider-status?revision=invalid"));
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/provider-status$/);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toMatch(/PRIVATE_FAILURE|CREDENTIALS/);
    expect(JSON.parse(text).providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "claude", status: "unknown", readiness: "unavailable", checkedAt: null }),
      expect.objectContaining({ provider: "codex", status: "unknown", readiness: "unavailable", checkedAt: null }),
    ]));
  });
});
