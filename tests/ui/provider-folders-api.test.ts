import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/provider-folders/route";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("provider folders local proxy", () => {
  it("uses a fixed no-store monitor request for a same-origin loopback caller", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"folders":{"claudeConfigDir":"C:\\\\Claude","claudeProjectsDir":null,"codexHome":null}}'));
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new Request("http://localhost:3003/api/provider-folders", { headers: { Host: "localhost:3003", Origin: "http://localhost:3003", "Sec-Fetch-Site": "same-origin" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4317/api/provider-folders", expect.objectContaining({ cache: "no-store" }));
  });

  it("refuses cross-origin, non-loopback, and query-bearing calls before proxying", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const request of [
      new Request("http://localhost:3003/api/provider-folders", { headers: { Host: "localhost:3003", Origin: "https://untrusted.example" } }),
      new Request("http://192.168.1.20:3003/api/provider-folders", { headers: { Host: "192.168.1.20:3003" } }),
      new Request("http://localhost:3003/api/provider-folders?path=private", { headers: { Host: "localhost:3003" } }),
      new Request("http://localhost:3003/api/provider-folders", { method: "POST", headers: { Host: "localhost:3003" } }),
      new Request("http://localhost:3003/api/provider-folders", { headers: { Host: "localhost:3003", "Content-Length": "1" } }),
      new Request("http://localhost:3003/api/provider-folders", { headers: { Host: "localhost:3003", "Sec-Fetch-Site": "cross-site" } }),
      new Request("http://localhost:3003/api/provider-folders", { headers: { Host: "localhost:3999" } }),
    ]) expect((await GET(request)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns only the fixed unavailable shape when the monitor fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("PRIVATE_PATH")));
    const response = await GET(new Request("http://127.0.0.1:3003/api/provider-folders", { headers: { Host: "127.0.0.1:3003" } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ folders: { claudeConfigDir: null, claudeProjectsDir: null, codexHome: null } });
  });
});
