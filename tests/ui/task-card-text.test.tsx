import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TaskCard } from "../../app/components/tasks/TaskCard";
import { inlineCodeParts, taskCardTitle, taskTextPreview } from "../../app/components/tasks/task-presentation";
import type { Task } from "../../shared/task-contract";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-63", text: "Rename the config key", columnId: "col-1", position: 0, featureId: null, group: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const LONG = "Show a row in the Events list when an agent changes a task with `update_task`. Today the list adds a row for four calls (task T-57).\n\nFollow the existing four exactly:\n- Map `update_task` to a new value.";

describe("taskTextPreview", () => {
  it("leads with the first sentence and joins the rest on one line", () => {
    expect(taskTextPreview(LONG)).toEqual({
      lead: "Show a row in the Events list when an agent changes a task with `update_task`.",
      rest: "Today the list adds a row for four calls (task T-57). Follow the existing four exactly: - Map `update_task` to a new value.",
      tags: [],
    });
  });

  it("keeps a first line of one sentence whole", () => {
    expect(taskTextPreview("Rename the config key")).toEqual({ lead: "Rename the config key", rest: "", tags: [] });
    expect(taskTextPreview("Fix the parser.\n\nIt drops the last row.")).toEqual({ lead: "Fix the parser.", rest: "It drops the last row.", tags: [] });
  });

  it("takes the tags of the first line off the title", () => {
    expect(taskTextPreview("[ backend ] [ recce ] Coverage opens a shot only on an action line. Every other line rides.")).toEqual({
      lead: "Coverage opens a shot only on an action line.", rest: "Every other line rides.", tags: ["backend", "recce"],
    });
  });

  it("lets the next line lead when the first line holds only tags", () => {
    expect(taskTextPreview("[ frontend ] [ tech-debt ]\nMake plan-intent atomic\nProblem: two tabs")).toEqual({
      lead: "Make plan-intent atomic", rest: "Problem: two tabs", tags: ["frontend", "tech-debt"],
    });
  });

  it("joins every leading line of only tags into the tags, and leads with the first text after them", () => {
    expect(taskTextPreview("[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent consume atomic across browser tabs\nProblem: two tabs")).toEqual({
      lead: "Make plan-intent consume atomic across browser tabs", rest: "Problem: two tabs", tags: ["frontend", "tech-debt", "ui"],
    });
    expect(taskTextPreview("[a]\n[b]\r\n\r\nTitle")).toEqual({ lead: "Title", rest: "", tags: ["a", "b"] });
    expect(taskTextPreview("[ui]\n\n[TODO] write tests\nmore")).toEqual({ lead: "write tests", rest: "more", tags: ["ui", "TODO"] });
    expect(taskTextPreview("Title\n[a]\nBody").tags).toEqual([]);
  });

  it("keeps a text of only tags as its title on one line, with no chips, however many lines hold the tags", () => {
    expect(taskTextPreview("[a]\n[b]\n")).toEqual({ lead: "[a] [b]", rest: "", tags: [] });
  });

  it("leaves brackets elsewhere as text, and keeps a text of only tags as its title", () => {
    expect(taskTextPreview("Fix [ bug ] in the cart")).toEqual({ lead: "Fix [ bug ] in the cart", rest: "", tags: [] });
    expect(taskTextPreview("[wip] [ui]")).toEqual({ lead: "[wip] [ui]", rest: "", tags: [] });
  });

  it("does not split inside a code span, at a short opening, or before a lowercase word", () => {
    expect(taskTextPreview("Read `docs/a. B.md` before the change of the cache").lead).toBe("Read `docs/a. B.md` before the change of the cache");
    expect(taskTextPreview("No. Keep the whole first line as the title here").lead).toBe("No. Keep the whole first line as the title here");
    expect(taskTextPreview("Keep the value of server/a.mjs vs. the other one").lead).toBe("Keep the value of server/a.mjs vs. the other one");
  });

  it("leaves out a heading mark", () => {
    expect(taskTextPreview("## Fix the parser\nIt drops rows.")).toEqual({ lead: "Fix the parser", rest: "It drops rows.", tags: [] });
    expect(taskTextPreview("[ui] # Fix the parser")).toEqual({ lead: "Fix the parser", rest: "", tags: ["ui"] });
  });

  it("skips blank lines of any kind after the tags, so the next non-empty line leads", () => {
    expect(taskTextPreview("[ui]\n\nFix the login\nmore")).toEqual({ lead: "Fix the login", rest: "more", tags: ["ui"] });
    expect(taskTextPreview("[ui] [x]\r\n   \r\nFix the login\r\nmore")).toEqual({ lead: "Fix the login", rest: "more", tags: ["ui", "x"] });
    expect(taskTextPreview("\n\nFix the login")).toEqual({ lead: "Fix the login", rest: "", tags: [] });
  });
});

describe("taskCardTitle", () => {
  it("is the session title, else the whole text without its tags", () => {
    const session = { id: "claude:s1", title: "Session title", state: "working", observedModel: null } as Task["session"];
    expect(taskCardTitle(task({ text: "[ bug ] Fix the cart\nSecond line" }))).toBe("Fix the cart\nSecond line");
    expect(taskCardTitle(task({ text: "[ bug ]\nFix the cart" }))).toBe("Fix the cart");
    expect(taskCardTitle(task({ text: "[ bug ] Fix the cart", session }))).toBe("Session title");
    expect(taskCardTitle(task({ text: "[ bug ]" }))).toBe("[ bug ]");
  });

  it("never starts with a blank line, and leaves out a heading mark, as the card does", () => {
    expect(taskCardTitle(task({ text: "[ui]\n\nFix\nSecond line" }))).toBe("Fix\nSecond line");
    expect(taskCardTitle(task({ text: "[ui] [x]\r\n \r\nFix" }))).toBe("Fix");
    expect(taskCardTitle(task({ text: "\n\n  # Fix the cart\n\nMore\n\n" }))).toBe("Fix the cart\n\nMore");
    expect(taskCardTitle(task({ text: "[ bug ]\n\n" }))).toBe("[ bug ]");
    expect(taskCardTitle(task({ text: "" }))).toBe("");
  });

  it("leaves the tags of every leading tag line out of the title and its tooltip", () => {
    expect(taskCardTitle(task({ text: "[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent atomic\nProblem: two tabs" }))).toBe("Make plan-intent atomic\nProblem: two tabs");
    expect(taskCardTitle(task({ text: "[a]\n[b]" }))).toBe("[a] [b]");
  });

  it("is the same text the card's tooltip carries", () => {
    const { container } = render(<ul><TaskCard task={task({ text: "[ui]\n\nFix the cart" })} /></ul>);
    expect(container.querySelector(".taskCardTitle")).toHaveAttribute("title", "Fix the cart");
    expect(container.querySelector(".taskCardTitle")?.textContent).toBe("Fix the cart");
  });
});

describe("inlineCodeParts", () => {
  it("puts each code span at an odd index and keeps a lone backtick as text", () => {
    expect(inlineCodeParts("Map `a` to `b` now")).toEqual(["Map ", "a", " to ", "b", " now"]);
    expect(inlineCodeParts("A lone ` stays")).toEqual(["A lone ` stays"]);
  });
});

describe("TaskCard text", () => {
  it("draws the first sentence as the title and code spans as code, with no excerpt of the rest", () => {
    const { container } = render(<ul><TaskCard task={task({ text: LONG })} /></ul>);
    const title = container.querySelector(".taskCardTitle") as HTMLElement;
    expect(title).toHaveTextContent("Show a row in the Events list when an agent changes a task with update_task.");
    expect(title.querySelector("code")).toHaveTextContent("update_task");
    expect(title).toHaveAttribute("title", LONG);
    expect(container.querySelector(".taskCardExcerpt")).toBeNull();
    expect(container).not.toHaveTextContent("Today the list adds a row");
  });

  it("draws the tags as neutral chips under the title, and leaves them out of the title and its tooltip", () => {
    const { container } = render(<ul><TaskCard task={task({ text: "[ backend ] [ recce ] [bug] Coverage opens a shot only on an action line." })} /></ul>);
    const title = container.querySelector(".taskCardTitle") as HTMLElement;
    expect(title.textContent).toBe("Coverage opens a shot only on an action line.");
    expect(title).toHaveAttribute("title", "Coverage opens a shot only on an action line.");
    const tags = container.querySelector(".taskTags") as HTMLElement;
    expect(tags).toHaveAttribute("aria-label", "Tags");
    expect([...tags.children].map((chip) => chip.textContent)).toEqual(["backend", "recce", "bug"]);
    for (const chip of tags.children) expect(chip).toHaveClass("commandChip", "taskTag");
    // Under the title.
    expect(title.compareDocumentPosition(tags) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws no tag row for a task without tags, and tags beside a session title", () => {
    const session = { id: "claude:s1", title: "Session title", state: "working", observedModel: null } as Task["session"];
    const { container } = render(<ul>
      <TaskCard task={task()} />
      <TaskCard task={task({ id: "T-64", text: "[ ui ] Polish the board", session })} />
    </ul>);
    expect(container.querySelector('[data-task-id="T-63"] .taskTags')).toBeNull();
    expect(container.querySelector('[data-task-id="T-64"] .taskCardTitle')?.textContent).toBe("Session title");
    expect(container.querySelector('[data-task-id="T-64"] .taskTags')?.textContent).toBe("ui");
  });

  it("leads with the next line when the first line holds only tags", () => {
    const { container } = render(<ul><TaskCard task={task({ text: "[ frontend ] [ tech-debt ]\nMake plan-intent atomic\nProblem: two tabs" })} /></ul>);
    expect(container.querySelector(".taskCardTitle")?.textContent).toBe("Make plan-intent atomic");
    expect([...container.querySelectorAll(".taskTag")].map((chip) => chip.textContent)).toEqual(["frontend", "tech-debt"]);
    expect(container).not.toHaveTextContent("Problem: two tabs");
  });

  it("shows no excerpt and no Complete when line on any card", () => {
    const session = { id: "claude:s1", title: "Events row for `update_task`", state: "working", observedModel: null } as Task["session"];
    const { container } = render(<ul>
      <TaskCard task={task({ completeWhen: { checks: ["pr_open"], own: "Reviewed" } })} />
      <TaskCard task={task({ id: "T-64", text: LONG, completeWhen: { checks: ["pr_open"], own: null } })} compact />
      <TaskCard task={task({ id: "T-65", text: LONG, session })} />
    </ul>);
    expect(container.querySelector(".taskCardExcerpt")).toBeNull();
    expect(container).not.toHaveTextContent(/Complete when/);
    expect(container.querySelector('[data-task-id="T-65"] .taskCardTitle')?.textContent).toBe("Events row for `update_task`");
  });

  it("clamps the title to three lines and draws no excerpt style", () => {
    const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
    expect(styles).toMatch(/\.taskCardTitle \{[^}]*-webkit-line-clamp: 3; line-clamp: 3/);
    expect(styles).not.toContain("taskCardExcerpt");
  });

  it("adds no underline to the title on hover", () => {
    const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
    const underlined = styles.split("\n").filter((line) => /\.taskCard(Open|Title)\b/.test(line) && line.includes("text-decoration"));
    expect(underlined).toEqual([]);
  });
});

describe("TaskCard open", () => {
  const session = { id: "claude:s1", title: null, state: "working", observedModel: null } as Task["session"];
  const move = { drag: {}, available: { up: true, down: true, left: false, right: true }, onMove: vi.fn() };

  it("opens from a click anywhere on the card, with the title as the opener", () => {
    const onOpen = vi.fn();
    const subject = task({ text: LONG, session });
    const { container } = render(<ul><TaskCard task={subject} onOpen={onOpen} move={move} /></ul>);
    const opener = screen.getByRole("button", { name: /Show a row in the Events list/ });
    const card = container.querySelector(".taskCard") as HTMLElement;
    expect(card).toHaveClass("isOpenable");
    expect(card).toHaveAttribute("draggable", "true");

    for (const target of [card, container.querySelector(".taskCardTop"), container.querySelector(".taskCardChip"), opener]) {
      onOpen.mockClear();
      fireEvent.click(target as HTMLElement);
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledWith(subject, opener);
    }
  });

  it("leaves a click on another control of the card to that control", () => {
    const onOpen = vi.fn();
    const { container } = render(<ul><TaskCard task={task({ session })} onOpen={onOpen} move={move} /></ul>);
    fireEvent.click(container.querySelector(".taskCardLink") as HTMLElement);
    for (const control of container.querySelectorAll(".taskCardMoves button")) fireEvent.click(control);
    expect(container.querySelectorAll(".taskCardMoves button").length).toBeGreaterThan(0);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens nothing on a card with no open action", () => {
    const { container } = render(<ul><TaskCard task={task()} /></ul>);
    expect(container.querySelector(".taskCard")).not.toHaveClass("isOpenable");
    expect(container.querySelector(".taskCardOpen")).toBeNull();
  });

  it("draws the title with no fill on hover or press, and the pointer cursor on a card that opens", () => {
    const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
    expect(styles).toContain(".taskCardOpen.commandQuietAction:hover:not(:disabled), .taskCardOpen.commandQuietAction:active:not(:disabled) { padding: 0; justify-content: flex-start; background: transparent;");
    expect(styles).toContain(".taskCard.isOpenable { cursor: pointer; }");
  });
});
