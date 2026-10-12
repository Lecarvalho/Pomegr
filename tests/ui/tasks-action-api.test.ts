import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as sessionsGet } from "../../app/api/sessions/route";
import { POST } from "../../app/api/tasks/action/route";

// POST /api/tasks/action: a paired device's one write. Only the desktop's LAN gateway reaches it, with its mark and
// the desktop token; the route holds the closed action list and answers a fixed result, never the board.

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const repositoryId = "repo-0123456789abcdef01234567";
const gateway = { Host: "127.0.0.1:3003", "x-pomegr-lan-gateway": "1", "x-pomegr-desktop-authorization": TOKEN, "Content-Type": "application/json" };

function post(body: unknown, headers: Record<string, string> = gateway, path = "/api/tasks/action") {
  return POST(new Request(`http://127.0.0.1:3003${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
}
const create = { repositoryId, action: "create", payload: { text: "From a phone" } };
const monitorAnswer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => { vi.stubEnv("POMEGR_MONITOR_TOKEN", TOKEN); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("POST /api/tasks/action", () => {
  it("sends a paired device's fixed action to the monitor's desktop-token route and answers only ok and the new task's ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(monitorAnswer({ ok: true, taskId: "T-7", board: { tasks: [{ text: "PRIVATE" }] } }));
    const response = await post(create);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, taskId: "T-7" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4317/internal/tasks/create");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { "x-pomegr-desktop-authorization": TOKEN, "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({ repositoryId, payload: { text: "From a phone" } });
  });

  it("answers a task ID only after a create", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => monitorAnswer({ ok: true, taskId: "T-7" }));
    expect(await (await post({ repositoryId, action: "move", payload: { id: "T-7", columnId: "col-2", position: 0 } })).json()).toEqual({ ok: true });
  });

  it("refuses every client that is not the gateway acting for a paired device, without calling the monitor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const without = (name: string) => Object.fromEntries(Object.entries(gateway).filter(([key]) => key !== name));
    const unmarked = without("x-pomegr-lan-gateway");
    const tokenless = without("x-pomegr-desktop-authorization");
    for (const headers of [
      unmarked,
      tokenless,
      { ...gateway, "x-pomegr-desktop-authorization": `${TOKEN.slice(0, -1)}x` },
      { ...gateway, Host: "192.168.1.20:3003" },
      { ...gateway, Origin: "http://127.0.0.1:3003" },
    ]) {
      const response = await post(create, headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: "unavailable" });
    }
    // The development server has no desktop token, so nobody is a paired device there.
    vi.stubEnv("POMEGR_MONITOR_TOKEN", "");
    expect((await post(create, { ...gateway, "x-pomegr-desktop-authorization": "" })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses anything outside the fixed envelope and the closed action list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const body of [
      "{", [], { ...create, extra: 1 }, { ...create, repositoryId: "repo-short" }, { ...create, payload: [] }, { ...create, payload: "x" },
      { ...create, action: "start-plan" }, { ...create, action: "queue-next" }, { ...create, action: "image-read" }, { ...create, action: "issue-create" },
      { ...create, action: "agent_create" }, { ...create, action: "../create" }, { ...create, payload: { text: "x".repeat(17 * 1024) } },
    ]) {
      expect(await (await post(body)).json()).toEqual({ ok: false, error: "invalid" });
    }
    expect(await (await post(create, { ...gateway, "Content-Type": "text/plain" })).json()).toEqual({ ok: false, error: "invalid" });
    expect(await (await post(create, gateway, "/api/tasks/action?x=1")).json()).toEqual({ ok: false, error: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes queue on, off, and other settings through the authorized monitor route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => monitorAnswer({ ok: true }));
    for (const payload of [{ on: true }, { on: false }, { threshold: 70 }, { schedule: { startAt: null, stopAfter: null } }]) {
      expect(await (await post({ repositoryId, action: "queue_settings", payload })).json()).toEqual({ ok: true });
      const [url, init] = fetchMock.mock.calls.at(-1)!;
      expect(url).toBe("http://127.0.0.1:4317/internal/tasks/queue_settings");
      expect(JSON.parse(String(init?.body))).toEqual({ repositoryId, payload });
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("answers the monitor's fixed error, and unavailable for anything else, never its text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(monitorAnswer({ ok: false, error: "conflict", detail: "PRIVATE" }, 409));
    expect(await (await post(create)).json()).toEqual({ ok: false, error: "conflict" });
    fetchMock.mockResolvedValueOnce(monitorAnswer({ ok: false, error: "C:\\private" }, 500));
    expect(await (await post(create)).json()).toEqual({ ok: false, error: "unavailable" });
    fetchMock.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    expect(await (await post(create)).json()).toEqual({ ok: false, error: "unavailable" });
    fetchMock.mockRejectedValueOnce(new Error("PRIVATE_PATH"));
    expect(await (await post(create)).json()).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("GET /api/sessions task references for a paired device", () => {
  it("marks a directory read the gateway forwarded with the desktop token, and no other marked read", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"sessions":[]}', { status: 200 }));
    const marked = async (headers: Record<string, string>) => {
      await sessionsGet(new Request("http://127.0.0.1:3003/api/sessions?mode=directory&tasks=0", { headers }));
      return new URL(String(fetchMock.mock.calls.at(-1)?.[0])).searchParams.getAll("tasks");
    };
    const paired = { host: "127.0.0.1:3003", "x-pomegr-lan-gateway": "1", "x-pomegr-desktop-authorization": TOKEN };
    expect(await marked(paired)).toEqual(["1"]);
    // The development server marks a peer that is not local and holds no token.
    expect(await marked({ host: "127.0.0.1:3003", "x-pomegr-lan-gateway": "1" })).toEqual([]);
    expect(await marked({ ...paired, "x-pomegr-desktop-authorization": "client-value" })).toEqual([]);
    expect(await marked({ ...paired, host: "192.168.1.20:3003" })).toEqual([]);
    vi.stubEnv("POMEGR_MONITOR_TOKEN", "");
    expect(await marked(paired)).toEqual([]);
  });
});
