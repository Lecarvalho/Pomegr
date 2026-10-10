import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { QueueTaskCard } from "../../app/components/tasks/QueueTaskCard";
import { TaskCard } from "../../app/components/tasks/TaskCard";
import { TaskCardIds, TaskIssueChip } from "../../app/components/tasks/TaskIssueChip";
import { taskIssueNumber, validIssueNumber } from "../../app/components/tasks/task-presentation";
import type { Task } from "../../shared/task-contract";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-34", text: "Retry a failed upload", columnId: "col-1", position: 0, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const promoted = task({ source: { kind: "github_issue", number: 142 } });
const list = (children: ReactNode) => <ul>{children}</ul>;

describe("TaskIssueChip", () => {
  it("is the shared outline chip with the number, a decorative glyph and a fixed accessible name", () => {
    render(<TaskIssueChip number={142} />);
    const chip = screen.getByRole("img", { name: "GitHub issue #142" });
    expect(chip).toHaveClass("commandChip", "taskIssueChip");
    expect(chip).toHaveTextContent("#142");
    expect(chip).toHaveAttribute("title", "Promoted from GitHub issue 142");
    const glyph = chip.querySelector("svg") as SVGElement;
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(glyph.getAttribute("stroke-width")).toBe("1.7");
  });

  it("is a label, never a link or a button", () => {
    const { container } = render(<TaskIssueChip number={7} />);
    expect(container.querySelector("a, button, [tabindex]")).toBeNull();
  });
});

describe("issue numbers", () => {
  it("accepts an integer from 1 to 999999999 and nothing else", () => {
    for (const valid of [1, 142, 999_999_999]) expect(validIssueNumber(valid)).toBe(valid);
    for (const invalid of [0, -1, 1.5, 1_000_000_000, Number.NaN, Infinity, "142", null, undefined, {}]) expect(validIssueNumber(invalid), String(invalid)).toBeNull();
  });

  it("reads a task's number from its source, and a missing or odd source as none", () => {
    expect(taskIssueNumber(promoted)).toBe(142);
    expect(taskIssueNumber(task())).toBeNull();
    expect(taskIssueNumber({ source: undefined } as unknown as Task)).toBeNull();
    expect(taskIssueNumber({ source: { kind: "pull_request", number: 4 } } as unknown as Task)).toBeNull();
    expect(taskIssueNumber({ source: { kind: "github_issue", number: 0 } } as Task)).toBeNull();
  });
});

describe("the chip on a card", () => {
  it("sits right after the task ID in the card's IDs group, before the state chip", () => {
    render(list(<TaskCard task={promoted} />));
    const card = screen.getByRole("listitem");
    const ids = card.querySelector(".taskCardIds") as HTMLElement;
    expect([...ids.children].map((child) => child.className)).toEqual(["taskCardId", "commandChip taskIssueChip"]);
    expect(ids.children[0]).toHaveTextContent("T-34");
    expect(within(ids).getByRole("img", { name: "GitHub issue #142" })).toHaveTextContent("#142");
    const top = card.querySelector(".taskCardTop") as HTMLElement;
    expect([...top.children].map((child) => child.className.split(" ")[0])).toEqual(["taskCardIds", "commandChip"]);
    expect(top.children[1]).toHaveTextContent("Not queued");
  });

  it("is absent for a task with no source, or with a source the product cannot print", () => {
    render(list(<>
      <TaskCard task={task()} />
      <TaskCard task={task({ id: "T-35", source: { kind: "github_issue", number: 0 } })} />
      <TaskCard task={{ ...task({ id: "T-36" }), source: undefined } as unknown as Task} />
    </>));
    expect(document.querySelectorAll(".taskIssueChip")).toHaveLength(0);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(document.querySelectorAll(".taskCardIds > .taskCardId")).toHaveLength(3);
  });

  it("shows the same chip on a queue card", () => {
    render(list(<QueueTaskCard task={promoted} nextQueued={false} />));
    const ids = screen.getByRole("listitem").querySelector(".taskCardIds") as HTMLElement;
    expect(ids).toHaveTextContent("T-34#142");
    expect(within(ids).getByRole("img", { name: "GitHub issue #142" })).toHaveClass("taskIssueChip");
  });

  it("renders the issue as text only: no link, no markup from the title", () => {
    const hostile = task({ text: "<img src=x onerror=alert(1)> [click](https://example.test)", source: { kind: "github_issue", number: 3 } });
    const { container } = render(list(<TaskCard task={hostile} />));
    expect(container.querySelector("a, img")).toBeNull();
    expect(container.querySelector(".taskIssueChip a")).toBeNull();
  });

  it("TaskCardIds alone prints just the ID for a task with no source", () => {
    const { container } = render(<TaskCardIds task={task()} />);
    expect(container).toHaveTextContent(/^T-34$/);
  });
});
