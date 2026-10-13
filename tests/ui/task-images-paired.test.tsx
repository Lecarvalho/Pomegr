import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  return {
    ...actual,
    clientAccessMode: () => "lan",
    useClientAccess: () => ({ mode: "lan", canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }),
  };
});

import { TaskModal } from "../../app/components/tasks/TaskModal";

const repositoryId = "repo-0123456789abcdef01234567";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const board = { columns: [{ id: "col-000000000001", name: "Backlog", position: 0 }], features: [], tasks: [] };
const fetchMock = vi.fn();

beforeEach(() => {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = undefined;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:pomegr/1"), revokeObjectURL: vi.fn() }));
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/tasks/action") return Response.json({ ok: true, taskId: "T-9" });
    return Response.json({ ok: true, imageId: new URL(url, "http://x").searchParams.get("imageId") });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Task images on a paired device", () => {
  it("offers Attach image and stores a picked image through the paired route after the task is created", async () => {
    render(<TaskModal mode="new" repositoryId={repositoryId} repositoryName="Example" board={board} refresh={async () => {}}
      onCreated={vi.fn()} onFollowUpFailed={vi.fn()} onClose={vi.fn()} />);
    const attach = screen.getByRole("button", { name: "Attach image" });
    const input = attach.parentElement!.querySelector<HTMLInputElement>("input[type=file]")!;
    fireEvent.change(input, { target: { files: [new File([PNG.slice()], "shot.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Task" }).querySelector("img")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Add task|^Create/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/tasks/image-add?"))).toBe(true));
    const [url, init] = fetchMock.mock.calls.find(([target]) => String(target).startsWith("/api/tasks/image-add?"))!;
    const query = new URL(url, "http://x").searchParams;
    expect([query.get("repositoryId"), query.get("taskId"), query.get("imageId")]).toEqual([repositoryId, "T-9", expect.stringMatching(/^img-[0-9a-f]{12}$/)]);
    expect(init.headers["Content-Type"]).toBe("application/octet-stream");
  });
});
