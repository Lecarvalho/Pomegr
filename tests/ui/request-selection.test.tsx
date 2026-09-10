import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RequestRow } from "../../app/components/dashboard/requests-actions/model";
import { useRequestSelection } from "../../app/components/dashboard/requests-actions/useRequestSelection";

function rows(count: number, first = 1): RequestRow[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = first + index;
    return {
      id: `request-${ordinal}`,
      agentId: "primary",
      observedAt: `2026-09-10T12:${String(ordinal).padStart(2, "0")}:00.000Z`,
      cacheLifetime: "1h",
      uncachedInputTokens: 1,
      cacheWriteTokens: 1,
      cacheReadTokens: 1,
      outputTokens: 1,
      totalTokens: 4,
      precedingWork: [],
      precedingAssociation: null,
      issuedWork: [],
      issuedAssociation: null,
      ordinal: index + 1,
      promptTokens: 3,
      freshTokens: 3,
      compactionBefore: false,
    };
  });
}

function useSelection(items: RequestRow[], historical = false, atLatest = true) {
  return useRequestSelection(items, "session:all", 3, historical, atLatest);
}

describe("useRequestSelection live following", () => {
  it("follows an appended newest row after selecting it, while preserving an older anchor", () => {
    const initial = rows(3);
    const { result, rerender } = renderHook(({ items }) => useSelection(items), { initialProps: { items: initial } });
    expect(result.current.selected?.id).toBe("request-3");
    expect(result.current.pinned).toBe(false);

    act(() => result.current.select(initial[1]));
    expect(result.current.selected?.id).toBe("request-2");
    expect(result.current.pinned).toBe(true);
    expect(result.current.navigation).toEqual({ id: "request-2", followLatest: false });

    const withFour = rows(4);
    rerender({ items: withFour });
    expect(result.current.selected?.id).toBe("request-2");
    expect(result.current.pinned).toBe(true);

    act(() => result.current.select(withFour[3], true));
    expect(result.current.selected?.id).toBe("request-4");
    expect(result.current.pinned).toBe(false);
    expect(result.current.navigation).toEqual({ id: "request-4", followLatest: true });

    rerender({ items: rows(5) });
    expect(result.current.selected?.id).toBe("request-5");
    expect(result.current.pinned).toBe(false);
  });

  it("returns to live following when keyboard stepping returns to the newest row", () => {
    const initial = rows(5);
    const { result } = renderHook(() => useSelection(initial));
    expect(result.current.selected?.id).toBe("request-5");
    expect(result.current.pinned).toBe(false);

    act(() => result.current.step(-1));
    expect(result.current.selected?.id).toBe("request-4");
    expect(result.current.pinned).toBe(true);
    expect(result.current.navigation).toEqual({ id: "request-4", followLatest: false });

    act(() => result.current.step(1));
    expect(result.current.selected?.id).toBe("request-5");
    expect(result.current.pinned).toBe(false);
    expect(result.current.navigation).toEqual({ id: "request-5", followLatest: true });
  });

  it("pins the initial and selected last row on an older page", () => {
    const older = rows(3, 4);
    const { result } = renderHook(() => useSelection(older, false, false));
    expect(result.current.selected?.id).toBe("request-6");
    expect(result.current.pinned).toBe(true);

    act(() => result.current.select(older[2]));
    expect(result.current.pinned).toBe(true);
    act(() => result.current.step(-1));
    expect(result.current.selected?.id).toBe("request-5");
    expect(result.current.pinned).toBe(true);
  });

  it("does not follow new rows for historical feeds", () => {
    const initial = rows(3);
    const { result, rerender } = renderHook(({ items }) => useSelection(items, true), { initialProps: { items: initial } });
    expect(result.current.pinned).toBe(true);
    rerender({ items: rows(4) });
    expect(result.current.selected?.id).toBe("request-3");
    expect(result.current.pinned).toBe(true);

    act(() => result.current.select(rows(4)[3]));
    expect(result.current.selected?.id).toBe("request-4");
    expect(result.current.pinned).toBe(true);
  });

  it("follows the newest request when a row link reveals another scope", () => {
    const initial = rows(3);
    const { result, rerender } = renderHook(({ items }) => useRequestSelection(items, "session:all", 3, false), { initialProps: { items: initial } });
    act(() => result.current.selectScope(initial, "session:all", initial[2]));
    expect(result.current.navigation).toEqual({ id: "request-3", followLatest: true });
    expect(result.current.pinned).toBe(false);
    rerender({ items: rows(4) });
    expect(result.current.selected?.id).toBe("request-4");
  });
});
