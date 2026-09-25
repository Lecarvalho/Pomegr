import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRepositoryFilesStoreForTests, useRepositoryFiles } from "../../app/repository-files-store";

const REPOSITORY_ID = `repo-${"0".repeat(23)}1`;

function listing(readiness: string, revision: number, files: unknown[] = []) {
  return { kind: "files", revision, readiness, repositoryId: REPOSITORY_ID, files, folders: [], historicalFolders: [], truncated: false };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("repository files browser store", () => {
  beforeEach(() => { resetRepositoryFilesStoreForTests(); vi.restoreAllMocks(); });
  afterEach(() => { vi.useRealTimers(); resetRepositoryFilesStoreForTests(); vi.restoreAllMocks(); });

  it("keeps the last ready listing when a later poll fails with a 503 unavailable body", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const file = { fileId: "f1", path: "a.txt", kind: "edited", sessionCount: 1, deleted: false };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(listing("ready", 1, [file])))
      .mockResolvedValue(json(listing("unavailable", 0), 503));
    const hook = renderHook(() => useRepositoryFiles(REPOSITORY_ID));
    await waitFor(() => expect(hook.result.current?.readiness).toBe("ready"));
    await vi.advanceTimersByTimeAsync(15_000);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(hook.result.current?.readiness).toBe("ready");
    expect(hook.result.current?.files).toHaveLength(1);
    hook.unmount();
  });

  it("downgrades a still-loading placeholder to unavailable when the first poll fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(listing("unavailable", 0), 503));
    const hook = renderHook(() => useRepositoryFiles(REPOSITORY_ID));
    await waitFor(() => expect(hook.result.current?.readiness).toBe("unavailable"));
    hook.unmount();
  });
});
