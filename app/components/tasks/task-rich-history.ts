import { TASK_BOUNDS } from "../../../shared/task-contract";

/**
 * The undo history of the rich Task field. The field keeps its own, because the browser's undo steps name the nodes the browser typed into,
 * and the field moves, splits, and draws those nodes again. A step is the whole text, so an undo or a redo can only give back a text
 * the field has held, and a chip is part of the text.
 */

export type RichCaret = { start: number; end: number };

/** The text, where the caret was, and how the field drew it. */
export type RichStep = {
  value: string;
  caret: RichCaret;
  /** The chips were drawn with a title line of their own (see `RichLayoutOptions`). */
  ownTitleLine: boolean;
};

/** What changed the text. Typing, Backspace, and Delete join the run before them when the caret goes on from it. */
export type RichEditKind = "type" | "backspace" | "delete" | "other";

export const RICH_HISTORY_LIMIT = 200;
/** The most characters the steps hold in all: a step is a whole text, so the steps are bounded by their size as well as their number. */
export const RICH_HISTORY_CHARACTERS = RICH_HISTORY_LIMIT * TASK_BOUNDS.textLength;

export class RichHistory {
  private steps: RichStep[] = [];
  private at = -1;
  private last: RichEditKind | null = null;

  /** Starts a new history from a text that was set from outside. */
  reset(step: RichStep) {
    this.steps = [step];
    this.at = 0;
    this.last = null;
  }

  /** Adds the text an edit made. `before` is where the caret was when the edit began, which an undo puts it back to. */
  record(step: RichStep, kind: RichEditKind, before: RichCaret | null) {
    if (this.at < 0) return this.reset(step);
    const top = this.steps[this.at];
    // An edit ends the redo branch, also one that leaves the text as it was.
    this.steps.length = this.at + 1;
    if (step.value === top.value) {
      this.last = null;
      return;
    }
    // Typing moves the caret on by what it adds, Backspace moves it back by what it takes, and Delete leaves it where it is.
    const added = step.value.length - top.value.length;
    const moved = step.caret.start - top.caret.start;
    const goesOn = kind === this.last && ((kind === "type" && added > 0 && moved === added) || (kind === "backspace" && added < 0 && moved === added) || (kind === "delete" && added < 0 && moved === 0));
    if (goesOn) {
      this.steps[this.at] = step;
      // A run that ends on the text before it would leave a step that undoes nothing: it goes.
      if (this.at > 0 && this.steps[this.at - 1].value === step.value) {
        this.steps.pop();
        this.at -= 1;
        this.last = null;
        return;
      }
    } else {
      if (before) top.caret = before;
      this.steps.push(step);
      this.at += 1;
    }
    while (this.at > 0 && (this.steps.length > RICH_HISTORY_LIMIT || this.size() > RICH_HISTORY_CHARACTERS)) {
      this.steps.shift();
      this.at -= 1;
    }
    this.last = kind;
  }

  private size() {
    return this.steps.reduce((total, held) => total + held.value.length, 0);
  }

  /** The step before the current one, or null when there is none. */
  undo(): RichStep | null {
    if (this.at <= 0) return null;
    this.last = null;
    this.at -= 1;
    return this.steps[this.at];
  }

  /** The step after the current one, or null when there is none. */
  redo(): RichStep | null {
    if (this.at < 0 || this.at >= this.steps.length - 1) return null;
    this.last = null;
    this.at += 1;
    return this.steps[this.at];
  }
}
