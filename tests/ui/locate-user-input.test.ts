import { describe, expect, it, vi } from "vitest";
import { locateUserInputRequest, userMessageRoute, userMessageRouteTime, type ReadActivityRows } from "../../app/components/dashboard/requests-actions/locate-user-input";

const BASE = Date.parse("2026-09-14T10:00:00.000Z");
const stamp = (second: number) => new Date(BASE + second * 1_000).toISOString();
type Row = { timestamp: string; tool: string; requestNumber: number | null };

/** Chronological history served 60 rows at a time, like the flat activity page. */
function history(rows: Row[]) {
  const read = vi.fn<ReadActivityRows>(async (offset) => {
    const start = offset === "latest" ? Math.max(0, rows.length - 60) : Math.min(offset, Math.max(0, rows.length - 1));
    return { offset: start, total: rows.length, items: rows.slice(start, start + 60) };
  });
  return read;
}
function rows(count: number, inputs: Record<number, number | null>): Row[] {
  return Array.from({ length: count }, (_, index) => Object.hasOwn(inputs, index)
    ? { timestamp: stamp(index), tool: "User input", requestNumber: inputs[index]! }
    : { timestamp: stamp(index), tool: "Read", requestNumber: 1 + Math.floor(index / 10) });
}

describe("user-message route", () => {
  it("round-trips a recorded time and rejects anything else", () => {
    expect(userMessageRoute(stamp(5))).toBe(`at:${BASE + 5_000}`);
    expect(userMessageRouteTime(`at:${BASE + 5_000}`)).toBe(BASE + 5_000);
    expect(userMessageRoute("not a time")).toBeNull();
    for (const value of ["12", "request-0123456789abcdef", "at:", "at:-1", "at:1x"]) expect(userMessageRouteTime(value)).toBeNull();
  });
});

describe("locateUserInputRequest", () => {
  it("finds the linked request on the latest page in one read", async () => {
    const read = history(rows(40, { 30: 7 }));
    expect(await locateUserInputRequest(BASE + 30_000, read)).toBe(7);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("bisects deep history to an old input in a bounded number of reads", async () => {
    const read = history(rows(5_000, { 137: 3, 4_990: 400 }));
    expect(await locateUserInputRequest(BASE + 137_000, read)).toBe(3);
    expect(read.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it("never substitutes a nearby request for an unlinked or absent input", async () => {
    expect(await locateUserInputRequest(BASE + 137_000, history(rows(500, { 137: null })))).toBeNull();
    expect(await locateUserInputRequest(BASE + 137_500, history(rows(500, { 137: 3 })))).toBeNull();
    expect(await locateUserInputRequest(BASE - 1_000, history(rows(500, {})))).toBeNull();
    expect(await locateUserInputRequest(BASE + 900_000, history(rows(500, {})))).toBeNull();
    expect(await locateUserInputRequest(BASE, history([]))).toBeNull();
  });

  it("reports an unreadable history as retryable rather than absent", async () => {
    expect(await locateUserInputRequest(BASE, async () => null)).toBeUndefined();
  });
});
