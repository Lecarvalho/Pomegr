import { describe, expect, it } from "vitest";
import { advanceOnGrowth, modeFor, selectionAfterCommit, stepTarget, transferOnViewportMove } from "../../app/components/dashboard/requests-actions/selection-viewport";

describe("advanceOnGrowth", () => {
  it("selects the new latest request while following", () => {
    expect(advanceOnGrowth({ total: 101, size: 60, selectedIndex: 99, mode: "follow" })).toEqual({ mode: "follow", offset: 41, selectedIndex: 100 });
    expect(advanceOnGrowth({ total: 4, size: 60, selectedIndex: 2, mode: "follow" })).toEqual({ mode: "follow", offset: 0, selectedIndex: 3 });
  });

  it("advances a tracking viewport while the selected bar stays visible", () => {
    // Selected position 50 of a 60-wide window: growth to 110 keeps it at offset 50.
    expect(advanceOnGrowth({ total: 110, size: 60, selectedIndex: 50, mode: "track" })).toEqual({ mode: "track", offset: 50, selectedIndex: 50 });
  });

  it("anchors the selected bar at the left edge at the moment advancing would push it out", () => {
    expect(advanceOnGrowth({ total: 111, size: 60, selectedIndex: 50, mode: "track" })).toEqual({ mode: "anchored", offset: 50, selectedIndex: 50 });
    expect(advanceOnGrowth({ total: 500, size: 60, selectedIndex: 50, mode: "track" })).toEqual({ mode: "anchored", offset: 50, selectedIndex: 50 });
  });

  it("keeps an anchored viewport and never clamps the selection to a false position", () => {
    const next = advanceOnGrowth({ total: 1_000, size: 60, selectedIndex: 3, mode: "anchored" });
    expect(next).toEqual({ mode: "anchored", offset: null, selectedIndex: 3 });
  });
});

describe("transferOnViewportMove", () => {
  it("keeps a visible selection", () => {
    expect(transferOnViewportMove({ selectedIndex: 70, offset: 40, size: 60 })).toBe(70);
    expect(transferOnViewportMove({ selectedIndex: 40, offset: 40, size: 60 })).toBe(40);
    expect(transferOnViewportMove({ selectedIndex: 99, offset: 40, size: 60 })).toBe(99);
  });

  it("transfers to the left edge when the window moves newer", () => {
    expect(transferOnViewportMove({ selectedIndex: 10, offset: 40, size: 60 })).toBe(40);
  });

  it("transfers to the right edge when the window moves older", () => {
    expect(transferOnViewportMove({ selectedIndex: 99, offset: 0, size: 60 })).toBe(59);
  });
});

describe("stepTarget", () => {
  it("steps inside the viewport without moving it", () => {
    expect(stepTarget({ selectedIndex: 50, delta: -1, total: 100, offset: 40, size: 60 })).toEqual({ index: 49, offset: null });
    expect(stepTarget({ selectedIndex: 50, delta: 5, total: 100, offset: 40, size: 60 })).toEqual({ index: 55, offset: null });
  });

  it("pages backward with the target at the right edge", () => {
    expect(stepTarget({ selectedIndex: 40, delta: -1, total: 100, offset: 40, size: 60 })).toEqual({ index: 39, offset: 0 });
    expect(stepTarget({ selectedIndex: 100, delta: -1, total: 200, offset: 100, size: 60 })).toEqual({ index: 99, offset: 40 });
  });

  it("pages forward with the target at the left edge, capped at the latest window", () => {
    expect(stepTarget({ selectedIndex: 59, delta: 1, total: 200, offset: 0, size: 60 })).toEqual({ index: 60, offset: 60 });
    expect(stepTarget({ selectedIndex: 59, delta: 1, total: 100, offset: 0, size: 60 })).toEqual({ index: 60, offset: 40 });
  });

  it("clamps range steps of five at both ends", () => {
    expect(stepTarget({ selectedIndex: 2, delta: -5, total: 100, offset: 0, size: 60 })).toEqual({ index: 0, offset: null });
    expect(stepTarget({ selectedIndex: 97, delta: 5, total: 100, offset: 40, size: 60 })).toEqual({ index: 99, offset: null });
    expect(stepTarget({ selectedIndex: 62, delta: -5, total: 200, offset: 60, size: 60 })).toEqual({ index: 57, offset: 0 });
  });
});

describe("modeFor", () => {
  it("derives follow, track and anchored from the committed viewport", () => {
    expect(modeFor({ selectedIndex: 99, offset: 40, size: 60, total: 100, explicitLatest: true })).toBe("follow");
    expect(modeFor({ selectedIndex: 99, offset: 40, size: 60, total: 100, explicitLatest: false })).toBe("track");
    expect(modeFor({ selectedIndex: 50, offset: 40, size: 60, total: 100, explicitLatest: false })).toBe("track");
    expect(modeFor({ selectedIndex: 50, offset: 39, size: 60, total: 100, explicitLatest: true })).toBe("anchored");
  });
});

describe("selectionAfterCommit", () => {
  const ids = (offset: number, count: number) => Array.from({ length: count }, (_, index) => `request-${offset + index + 1}`);
  const base = { size: 60, historical: false };

  it("commits an explicit drag transfer as the anchored selection", () => {
    expect(selectionAfterCommit({ ...base, ids: ids(0, 60), offset: 0, total: 301, target: { select: 59 }, previous: { mode: "follow", keep: { id: "request-300", index: 299 } } }))
      .toEqual({ mode: "anchored", keep: { id: "request-60", index: 59 }, offset: 0 });
  });

  it("keeps a verified refresh selection and never follows a pinned lookup", () => {
    const keep = { id: "request-50", index: 49 };
    expect(selectionAfterCommit({ ...base, ids: ids(40, 60), offset: 40, total: 100, target: { keep }, previous: { mode: "track", keep } }))
      .toEqual({ mode: "track", keep, offset: 40 });
    expect(selectionAfterCommit({ ...base, ids: ids(40, 60), offset: 40, total: 100, target: { requestId: "request-100", pin: true }, previous: { mode: "follow", keep: null } }).mode).toBe("track");
    expect(selectionAfterCommit({ ...base, ids: ids(40, 60), offset: 40, total: 100, target: { requestId: "request-100", pin: false }, previous: { mode: "track", keep } }).mode).toBe("follow");
  });

  it("resolves an absent route lookup to the newest request and otherwise retains or falls back", () => {
    expect(selectionAfterCommit({ ...base, ids: ids(40, 60), offset: 40, total: 100, target: { requestId: "gone", absentToLatest: true }, previous: { mode: "anchored", keep: { id: "request-3", index: 2 } } }))
      .toEqual({ mode: "follow", keep: { id: "request-100", index: 99 }, offset: 40 });
    expect(selectionAfterCommit({ ...base, ids: ids(0, 60), offset: 0, total: 120, target: { requestId: "gone" }, previous: { mode: "anchored", keep: { id: "request-13", index: 12 } } }))
      .toEqual({ mode: "anchored", keep: { id: "request-13", index: 12 }, offset: 0 });
    expect(selectionAfterCommit({ ...base, ids: ids(40, 60), offset: 40, total: 100, target: {}, previous: { mode: "follow", keep: { id: "request-99", index: 98 } } }))
      .toEqual({ mode: "follow", keep: { id: "request-100", index: 99 }, offset: 40 });
    expect(selectionAfterCommit({ ...base, ids: [], offset: 0, total: 0, target: {}, previous: { mode: "follow", keep: null } })).toEqual({ mode: "follow", keep: null, offset: 0 });
  });
});
