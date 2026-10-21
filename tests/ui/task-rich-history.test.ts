import { describe, expect, it } from "vitest";
import { RICH_HISTORY_CHARACTERS, RICH_HISTORY_LIMIT, RichHistory, type RichStep } from "../../app/components/tasks/task-rich-history";

const step = (value: string, caret = value.length, extra: Partial<RichStep> = {}): RichStep => ({ value, caret: { start: caret, end: caret }, ownTitleLine: false, stored: false, ...extra });

function started(value = "") {
  const history = new RichHistory();
  history.reset(step(value, value.length, { stored: true }));
  return history;
}

describe("RichHistory", () => {
  it("goes back and forward through the steps and stops at both ends", () => {
    const history = started("a");
    history.record(step("ab"), "other", null);
    history.record(step("abc"), "other", null);
    expect(history.undo()?.value).toBe("ab");
    expect(history.undo()?.value).toBe("a");
    expect(history.undo()).toBeNull();
    expect(history.redo()?.value).toBe("ab");
    expect(history.redo()?.value).toBe("abc");
    expect(history.redo()).toBeNull();
  });

  it("has nothing to undo or redo before a text is set", () => {
    const history = new RichHistory();
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
    history.record(step("a"), "type", null);
    expect(history.undo()).toBeNull();
  });

  it("gives back only texts that were held, so an undo and a redo never change a text", () => {
    const history = started("Fix the bug");
    history.record(step("[ui] Fix the bug", 5), "type", null);
    expect(history.undo()?.value).toBe("Fix the bug");
    expect(history.redo()?.value).toBe("[ui] Fix the bug");
    expect(history.redo()).toBeNull();
    expect(history.undo()?.value).toBe("Fix the bug");
    expect(history.undo()).toBeNull();
  });

  it("joins typing that goes on from the caret into one step", () => {
    const history = started("");
    history.record(step("a"), "type", null);
    history.record(step("ab"), "type", null);
    history.record(step("abc"), "type", null);
    expect(history.undo()?.value).toBe("");
    expect(history.undo()).toBeNull();
    expect(history.redo()?.value).toBe("abc");
  });

  it("joins a run of Backspace, and a run of Delete, but not one into the other", () => {
    const back = started("abcd");
    back.record(step("abc"), "backspace", null);
    back.record(step("ab"), "backspace", null);
    expect(back.undo()?.value).toBe("abcd");
    const forward = started("abcd");
    forward.record(step("bcd", 0), "delete", null);
    forward.record(step("cd", 0), "delete", null);
    expect(forward.undo()?.value).toBe("abcd");
    const mixed = started("abcd");
    mixed.record(step("abc"), "backspace", null);
    mixed.record(step("bc", 0), "delete", null);
    expect(mixed.undo()?.value).toBe("abc");
    expect(mixed.undo()?.value).toBe("abcd");
  });

  it("starts a new step when the caret did not go on from the edit before, when the kind changes, or for any other edit", () => {
    const moved = started("");
    moved.record(step("a"), "type", null);
    moved.record(step("xa", 1), "type", null);
    expect(moved.undo()?.value).toBe("a");
    const kinds = started("");
    kinds.record(step("ab"), "type", null);
    kinds.record(step("a"), "backspace", null);
    expect(kinds.undo()?.value).toBe("ab");
    const other = started("");
    other.record(step("a"), "other", null);
    other.record(step("ab"), "other", null);
    expect(other.undo()?.value).toBe("a");
  });

  it("does not join an edit into a run that an undo or a redo ended", () => {
    const history = started("");
    history.record(step("a"), "type", null);
    history.record(step("ab"), "other", null);
    history.undo();
    history.record(step("ac"), "type", null);
    expect(history.undo()?.value).toBe("a");
  });

  it("drops the steps after the current one when a new edit is made", () => {
    const history = started("");
    history.record(step("a"), "other", null);
    history.record(step("ab"), "other", null);
    history.undo();
    history.record(step("ac"), "other", null);
    expect(history.redo()).toBeNull();
    expect(history.undo()?.value).toBe("a");
  });

  it("puts the caret back where the edit began", () => {
    const history = started("abc");
    history.record(step("abcd"), "type", { start: 1, end: 1 });
    expect(history.undo()?.caret).toEqual({ start: 1, end: 1 });
    expect(history.redo()?.caret).toEqual({ start: 4, end: 4 });
  });

  it("ignores an edit that leaves the text as it was", () => {
    const history = started("abc");
    history.record(step("abc", 1), "other", null);
    expect(history.undo()).toBeNull();
  });

  it("starts again when a text is set from outside", () => {
    const history = started("one");
    history.record(step("one two"), "other", null);
    history.reset(step("three", 5, { stored: true }));
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
    history.record(step("three!"), "other", null);
    expect(history.undo()).toMatchObject({ value: "three", stored: true });
  });

  it("keeps how a step was drawn", () => {
    const history = started("[a] ");
    history.record(step("[a] \nBody", 9, { ownTitleLine: true }), "other", null);
    expect(history.undo()).toMatchObject({ value: "[a] ", stored: true, ownTitleLine: false });
    expect(history.redo()).toMatchObject({ value: "[a] \nBody", ownTitleLine: true });
  });

  it("drops a run that ends on the text before it, so one undo never seems to do nothing", () => {
    // Select all, then type the same text again.
    const history = started("abc");
    history.record(step("a", 1), "type", null);
    history.record(step("ab", 2), "type", null);
    history.record(step("abc", 3), "type", null);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
    // The run is over, so typing after it starts a step of its own.
    history.record(step("abcd", 4), "type", null);
    expect(history.undo()?.value).toBe("abc");
    expect(history.undo()).toBeNull();
  });

  it("drops a whole run that returns to its start", () => {
    const history = started("Z");
    history.record(step("Zy", 2), "type", null);
    history.record(step("Zyx", 3), "type", null);
    history.record(step("Zy", 2), "backspace", null);
    history.record(step("Z", 1), "backspace", null);
    expect(history.undo()?.value).toBe("Zyx");
    expect(history.undo()?.value).toBe("Z");
    expect(history.undo()).toBeNull();
  });

  it("ends the redo branch for an edit that leaves the text as it was", () => {
    const history = started("");
    history.record(step("Z"), "other", null);
    history.record(step("Q"), "other", null);
    history.undo();
    // Select all and type "Z" over "Z": the text is the same, the edit is real.
    history.record(step("Z"), "type", null);
    expect(history.redo()).toBeNull();
    expect(history.undo()?.value).toBe("");
  });

  it("does not join an edit into a run after an edit that left the text as it was", () => {
    const history = started("");
    history.record(step("a"), "type", null);
    history.record(step("a", 0), "type", null);
    history.record(step("ab", 1), "type", null);
    expect(history.undo()?.value).toBe("a");
  });

  it("forgets the oldest steps while the steps hold more characters than the bound", () => {
    const big = "x".repeat(RICH_HISTORY_CHARACTERS / 4);
    const history = started("0");
    for (let index = 1; index <= 8; index += 1) history.record(step(`${index}${big}`), "other", null);
    let undone = 0;
    while (history.undo()) undone += 1;
    // Each text is a little over a quarter of the bound, so three fit and the fourth does not: the steps 6, 7, and 8 stay.
    expect(undone).toBe(2);
    expect(history.redo()?.value.startsWith("7")).toBe(true);
  });

  it("keeps the current step whatever its size", () => {
    const history = started("0");
    history.record(step("y".repeat(RICH_HISTORY_CHARACTERS * 2)), "other", null);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });

  it("keeps at most the limit of steps and forgets the oldest", () => {
    const history = started("0");
    for (let index = 1; index <= RICH_HISTORY_LIMIT + 50; index += 1) history.record(step(String(index)), "other", null);
    let undone = 0;
    while (history.undo()) undone += 1;
    expect(undone).toBe(RICH_HISTORY_LIMIT - 1);
    expect(history.redo()?.value).toBe(String(RICH_HISTORY_LIMIT + 50 - (RICH_HISTORY_LIMIT - 1) + 1));
  });
});
