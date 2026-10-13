import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskCard } from "../../app/components/tasks/TaskCard";
import { inlineCodeParts, taskTextPreview } from "../../app/components/tasks/task-presentation";
import type { Task } from "../../shared/task-contract";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-63", text: "Rename the config key", columnId: "col-1", position: 0, featureId: null, step: null,
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
    });
  });

  it("keeps a first line of one sentence whole", () => {
    expect(taskTextPreview("Rename the config key")).toEqual({ lead: "Rename the config key", rest: "" });
    expect(taskTextPreview("Fix the parser.\n\nIt drops the last row.")).toEqual({ lead: "Fix the parser.", rest: "It drops the last row." });
  });

  it("does not split inside a code span, at a short opening, or before a lowercase word", () => {
    expect(taskTextPreview("Read `docs/a. B.md` before the change of the cache").lead).toBe("Read `docs/a. B.md` before the change of the cache");
    expect(taskTextPreview("No. Keep the whole first line as the title here").lead).toBe("No. Keep the whole first line as the title here");
    expect(taskTextPreview("Keep the value of server/a.mjs vs. the other one").lead).toBe("Keep the value of server/a.mjs vs. the other one");
  });

  it("leaves out a heading mark", () => {
    expect(taskTextPreview("## Fix the parser\nIt drops rows.")).toEqual({ lead: "Fix the parser", rest: "It drops rows." });
  });
});

describe("inlineCodeParts", () => {
  it("puts each code span at an odd index and keeps a lone backtick as text", () => {
    expect(inlineCodeParts("Map `a` to `b` now")).toEqual(["Map ", "a", " to ", "b", " now"]);
    expect(inlineCodeParts("A lone ` stays")).toEqual(["A lone ` stays"]);
  });
});

describe("TaskCard text", () => {
  it("draws the first sentence as the title, the rest as an excerpt, and code spans as code", () => {
    const { container } = render(<ul><TaskCard task={task({ text: LONG })} /></ul>);
    const title = container.querySelector(".taskCardTitle") as HTMLElement;
    expect(title).toHaveTextContent("Show a row in the Events list when an agent changes a task with update_task.");
    expect(title.querySelector("code")).toHaveTextContent("update_task");
    expect(title).toHaveAttribute("title", LONG);
    const excerpt = container.querySelector(".taskCardExcerpt") as HTMLElement;
    expect(excerpt.textContent).toBe("Today the list adds a row for four calls (task T-57). Follow the existing four exactly: - Map update_task to a new value.");
  });

  it("shows no excerpt for a short text, a grouped card, or a session title", () => {
    const session = { id: "claude:s1", title: "Events row for `update_task`", state: "working", observedModel: null } as Task["session"];
    const { container } = render(<ul>
      <TaskCard task={task()} />
      <TaskCard task={task({ id: "T-64", text: LONG })} grouped />
      <TaskCard task={task({ id: "T-65", text: LONG, session })} />
    </ul>);
    expect(container.querySelector(".taskCardExcerpt")).toBeNull();
    expect(container.querySelector('[data-task-id="T-65"] .taskCardTitle')?.textContent).toBe("Events row for `update_task`");
  });

  it("clamps the title to three lines and the excerpt to two", () => {
    const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
    expect(styles).toMatch(/\.taskCardTitle \{[^}]*-webkit-line-clamp: 3; line-clamp: 3/);
    expect(styles).toMatch(/\.taskCardExcerpt \{[^}]*-webkit-line-clamp: 2; line-clamp: 2[^}]*color: var\(--command-muted\)/);
  });

  it("adds no underline to the title or the excerpt on hover", () => {
    const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
    const underlined = styles.split("\n").filter((line) => /\.taskCard(Open|Title|Excerpt)\b/.test(line) && line.includes("text-decoration"));
    expect(underlined).toEqual([]);
  });
});
