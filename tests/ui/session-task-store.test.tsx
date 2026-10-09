import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSessionTaskAnswer, parseSessionTaskReference, useSessionTaskReference } from "../../app/session-task-store";

const SESSION = "claude:session-2";
const REFERENCE = { id: "T-14", repositoryId: `repo-${"a".repeat(24)}`, state: null, featureId: "feat-0123456789ab", feature: "Task board v1", step: 2 };
const page = (task: unknown, taskReadiness = "ready") => ({ sessions: [{ id: SESSION, ...(task === undefined ? {} : { task }) }], taskReadiness });

function Probe() {
  const result = useSessionTaskReference(SESSION);
  return <output>{result.status}:{result.task?.id ?? "none"}</output>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("session task reference", () => {
  it("keeps only a reference that matches the contract", () => {
    expect(parseSessionTaskReference({ ...REFERENCE, text: "SECRET" })).toEqual(REFERENCE);
    for (const invalid of [{ ...REFERENCE, id: "14" }, { ...REFERENCE, repositoryId: "C:\repo" }, { ...REFERENCE, state: "running" }, { ...REFERENCE, step: 0 }, { ...REFERENCE, feature: "a\nb" }, null, []]) {
      expect(parseSessionTaskReference(invalid)).toBeNull();
    }
  });

  it("reads present, absent and unknown from a directory answer", () => {
    expect(parseSessionTaskAnswer(page(REFERENCE), SESSION)).toEqual({ status: "present", task: REFERENCE });
    expect(parseSessionTaskAnswer(page(null), SESSION)).toEqual({ status: "absent", task: null });
    expect(parseSessionTaskAnswer(page(undefined, "desktop_only"), SESSION)).toEqual({ status: "absent", task: null });
    // Unknown: the store could not be read, the row is not listed yet, or the reference is malformed.
    expect(parseSessionTaskAnswer(page(undefined, "unavailable"), SESSION)).toBeNull();
    expect(parseSessionTaskAnswer({ sessions: [], taskReadiness: "ready" }, SESSION)).toBeNull();
    expect(parseSessionTaskAnswer(page({ ...REFERENCE, id: "x" }), SESSION)).toBeNull();
    expect(parseSessionTaskAnswer(page(REFERENCE), "claude:other")).toBeNull();
  });

  it("asks for the session's own row and keeps a shown task when a later read fails", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(page(REFERENCE)), { status: 200 })).mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("loading:none");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status").textContent).toBe("present:T-14");
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect([url.pathname, url.searchParams.get("mode"), url.searchParams.get("session"), url.searchParams.get("pageSize")]).toEqual(["/api/sessions", "directory", SESSION, "1"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toBe("present:T-14");
  });

  it("stops asking once the client is told it is not on the same computer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(page(undefined, "desktop_only")), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status").textContent).toBe("absent:none");
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
