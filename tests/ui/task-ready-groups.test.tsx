import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/task-contract";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { taskColumns } from "../../app/components/tasks/task-presentation";
import { idList, linkIds, readySegments, READY_GROUP_LIMIT } from "../../app/components/tasks/task-ready-groups";
import { startsParts } from "../../app/components/tasks/task-schedule";
import { GROUP_A, GROUP_B, READY, board, gates, running, task, tasks } from "./task-group-fixtures";

const lane = (name: string) => screen.getByRole("region", { name }) as HTMLElement;
const card = (id: string) => document.querySelector(`li[data-task-id="${id}"]`) as HTMLElement;
const frames = () => [...lane("Ready").querySelectorAll<HTMLElement>(".taskReadyGroup")];
const ready = (value = board()) => taskColumns(value)[1].tasks;
const ids = (cards: readonly Task[]) => cards.map((item) => item.id);

describe("readySegments", () => {
  it("projects the lane's order into segments without moving a card", () => {
    const value = board();
    const segments = readySegments(ready(value), value);
    expect(segments.map((segment) => segment.kind)).toEqual(["parallel", "card", "card", "card", "card", "parallel"]);
    expect(segments.flatMap((segment) => segment.kind === "card" ? [segment.task.id] : ids(segment.tasks))).toEqual(READY);
    expect(segments.filter((segment) => segment.kind === "card").map((segment) => segment.kind === "card" && segment.waiting)).toEqual([true, true, false, true]);
  });

  it("makes no group from adjacency alone", () => {
    const value = { tasks: [task(1, { position: 0 }), task(2, { position: 1 }), task(3, { position: 2 })] };
    expect(readySegments(value.tasks, value).map((segment) => segment.kind)).toEqual(["card", "card", "card"]);
  });

  it("makes one frame of the waiting cards that share a group, started siblings aside", () => {
    const value = board();
    const [frame] = readySegments(ready(value), value);
    expect(frame).toMatchObject({ kind: "parallel", group: GROUP_A, started: ["T-3"] });
    expect(frame.kind === "parallel" && ids(frame.tasks)).toEqual(["T-1", "T-2"]);
  });

  it("keeps cards of different features in one frame", () => {
    const value = board();
    const [frame] = readySegments(ready(value), value);
    expect(frame.kind === "parallel" && frame.tasks.map((item) => item.featureId)).toEqual(["f1", "f2"]);
  });

  it("splits a frame at a card that does not wait", () => {
    const value = { tasks: [task(1, { group: GROUP_A, position: 0 }), task(2, { state: "not_queued", position: 1 }), task(3, { group: GROUP_A, position: 2 })] };
    const segments = readySegments(value.tasks, value);
    expect(segments.map((segment) => segment.kind)).toEqual(["parallel", "card", "parallel"]);
    expect(segments.map((segment) => segment.kind === "parallel" ? ids(segment.tasks) : [segment.task.id])).toEqual([["T-1"], ["T-2"], ["T-3"]]);
  });

  it("splits a frame at a card of another group, and keeps two groups apart", () => {
    const value = { tasks: [task(1, { group: GROUP_A, position: 0 }), task(2, { group: GROUP_B, position: 1 }), task(3, { group: GROUP_B, position: 2 }), task(4, { group: GROUP_A, position: 3 })] };
    expect(readySegments(value.tasks, value).map((segment) => segment.kind === "parallel" ? ids(segment.tasks) : [])).toEqual([["T-1"], ["T-2", "T-3"], ["T-4"]]);
  });

  it("lists the members in flight by number, not by text order", () => {
    const flying = [task(12, { group: GROUP_A, columnId: "col-3", session: running }), task(3, { group: GROUP_A, columnId: "col-3", session: running }), task(9, { group: GROUP_B, columnId: "col-3", session: running })];
    const waiting = [task(20, { group: GROUP_A, position: 0 }), task(21, { group: GROUP_A, position: 1 })];
    const [frame] = readySegments(waiting, { tasks: [...waiting, ...flying] });
    expect(frame).toMatchObject({ kind: "parallel", started: ["T-3", "T-12"] });
  });
});

describe("linkIds", () => {
  const segments = () => {
    const value = board();
    return readySegments(ready(value), value);
  };

  it("names both sides, in lane order, between two waiting segments", () => {
    const [groupA, four, five, seven, six, groupB] = segments();
    expect(linkIds(groupA, four)).toEqual(["T-1", "T-2", "T-4"]);
    expect(linkIds(four, five)).toEqual(["T-4", "T-5"]);
    expect(linkIds(six, groupB)).toEqual(["T-6", "T-8", "T-9"]);
    expect(linkIds(groupA, groupB)).toEqual(["T-1", "T-2", "T-8", "T-9"]);
    expect(linkIds(five, seven)).toBeNull();
    expect(linkIds(seven, six)).toBeNull();
  });

  it("is null without a segment on a side", () => {
    const [groupA] = segments();
    expect(linkIds(undefined, groupA)).toBeNull();
    expect(linkIds(groupA, undefined)).toBeNull();
  });

  it(`stays within ${READY_GROUP_LIMIT} members, counting the siblings that already started`, () => {
    const group = (name: string, waiting: number, started: number) => {
      const members = Array.from({ length: waiting }, (_, index) => task(index + 1, { group: name, position: index }));
      const flying = Array.from({ length: started }, (_, index) => task(100 + index, { group: name, columnId: "col-3", session: running }));
      return readySegments(members, { tasks: [...members, ...flying] })[0];
    };
    const single = readySegments([task(50, { position: 0 })], { tasks: [] })[0];
    expect(linkIds(group(GROUP_A, 8, 7), single)).toHaveLength(9);
    expect(linkIds(group(GROUP_A, 8, 8), single)).toBeNull();
    expect(linkIds(group(GROUP_A, 8, 0), group(GROUP_B, 8, 0))).toHaveLength(16);
    expect(linkIds(group(GROUP_A, 9, 0), group(GROUP_B, 8, 0))).toBeNull();
  });

  it("reads a list of IDs aloud", () => {
    expect([idList(["T-4"]), idList(["T-4", "T-5"]), idList(["T-4", "T-5", "T-9"])]).toEqual(["T-4", "T-4 and T-5", "T-4, T-5, and T-9"]);
  });
});

describe("the Ready lane's parallel groups", () => {
  it("frames the waiting cards of a group, in the lane's own order, and counts the cards waiting", () => {
    render(<TaskBoardView board={board()} />);
    const [first, second] = frames();
    expect(frames()).toHaveLength(2);
    expect(first).toHaveAttribute("data-ready-group", GROUP_A);
    expect(first.querySelector(".taskReadyMode")?.textContent).toBe("Parallel · 2 · T-3 started");
    expect(first.querySelector(".taskReadyMode svg")).toHaveAttribute("aria-hidden", "true");
    expect([...first.querySelectorAll("li.taskCard")].map((item) => item.getAttribute("data-task-id"))).toEqual(["T-1", "T-2"]);
    expect(within(first).getByRole("list", { name: "Parallel group of T-1 and T-2" })).toBeInTheDocument();
    expect(second.querySelector(".taskReadyMode")?.textContent).toBe("Parallel · 2");
    expect(second.querySelector(".taskReadyStarted")).toBeNull();
  });

  it("frames a group with one card waiting, and names every sibling that started", () => {
    const value = board();
    value.tasks = value.tasks.map((item) => item.id === "T-2" ? { ...item, columnId: "col-3", session: running } : item);
    render(<TaskBoardView board={value} />);
    expect(frames()[0].querySelector(".taskReadyMode")?.textContent).toBe("Parallel · 1 · T-2 and T-3 started");
  });

  it("draws a card that is not in a group where it is, with no frame and no step text anywhere", () => {
    render(<TaskBoardView board={board()} />);
    expect(card("T-4").closest(".taskReadyGroup")).toBeNull();
    expect(card("T-7").closest(".taskReadyGroup")).toBeNull();
    const text = document.body.textContent ?? "";
    for (const word of ["Step", "Move to step", "Single tasks", "One at a time", "step "]) expect(text, word).not.toContain(word);
    expect(Object.keys(tasks()[0])).not.toContain("step");
  });

  it("draws a waiting card compact, with its run and the feature name only", () => {
    render(<TaskBoardView board={board()} />);
    expect(card("T-1")).toHaveClass("taskReadyCard");
    expect(card("T-1").querySelector(".taskCardPlanned")).toHaveTextContent("model-large · high");
    expect(card("T-1").querySelector(".taskCardFeature")?.textContent).toBe("Tasks adjustments");
    expect(card("T-2").querySelector(".taskCardFeature")?.textContent).toBe("Aril chat polish");
    expect([...card("T-1").querySelectorAll(".taskCardDetail")].map((item) => item.className)).toEqual(["taskCardDetail taskCardFeature"]);
    // A card of Ready that does not wait in the queue stays a plain board card where it is.
    expect(card("T-7")).not.toHaveClass("taskReadyCard");
    // The started sibling is a plain card of its own lane, named by its feature.
    expect(card("T-3").closest(".taskReadyGroup")).toBeNull();
    expect(card("T-3").querySelector(".taskCardFeature")?.textContent).toBe("Tasks adjustments");
  });

  it("keeps Queued · next and adds the Waiting line only while the queue is on", () => {
    const next = { taskId: "T-1", provider: "claude" as const, blockedBy: null, reasons: ["usage_over" as const] };
    const open = (status: "running" | "idle") => board({ queue: { status, blockedBy: null, pauseReason: null, order: ["T-1", "T-2", "T-4"], gates: gates(next, { usage: { claude: { status: "over", fiveHourPercent: 91, sevenDayPercent: 37 }, codex: { status: "ok", fiveHourPercent: 1, sevenDayPercent: 1 } } }) } });
    const { unmount } = render(<TaskBoardView board={open("running")} />);
    expect(card("T-1").querySelector(".taskCardChip")).toHaveTextContent("Queued · next");
    expect(card("T-1").querySelector(".taskCardWaiting")?.textContent).toBe("Waiting: Claude Code is above 85% of the five-hour window · T-3 started");
    // Without the monitor's waits only the next task reads the gates; its sibling reads nothing of its own.
    expect(card("T-2").querySelector(".taskCardWaiting")).toBeNull();
    expect(card("T-4").querySelector(".taskCardWaiting")).toBeNull();
    expect(card("T-8").querySelector(".taskCardWaiting")).toBeNull();
    unmount();
    render(<TaskBoardView board={open("idle")} />);
    expect(card("T-1").querySelector(".taskCardWaiting")).toBeNull();
  });

  it("names a scheduled card's day and puts its time in the data font", () => {
    const at = (hour: number) => new Date(2026, 9, 12, hour).toISOString();
    const value = board();
    value.tasks = value.tasks.map((item) => item.id === "T-5" ? { ...item, state: "scheduled" as const, scheduledAt: at(22) } : item);
    render(<TaskBoardView board={value} />);
    expect(card("T-5").querySelector(".taskCardChip")).toHaveClass("info");
    expect(card("T-5").querySelector(".taskCardChip")).toHaveTextContent("Scheduled");
    expect(card("T-5").querySelector(".taskCardStartsTime")).toHaveTextContent("22:00");
    const scheduled = { state: "scheduled", scheduledAt: at(22), session: null } as const;
    expect(startsParts(scheduled, Date.parse(at(9)))).toEqual({ day: "today", time: "22:00" });
    expect(startsParts(scheduled, Date.parse(at(9)) - 86_400_000)).toEqual({ day: "Oct 12,", time: "22:00" });
  });

  it("groups no other lane and counts cards, not groups", () => {
    render(<TaskBoardView board={board()} />);
    expect(lane("Ready").querySelector(".taskColumnCount")).toHaveTextContent("8 tasks");
    expect(lane("In progress").querySelector(".taskReadyGroup")).toBeNull();
    expect(document.querySelectorAll(".taskReadyGroup")).toHaveLength(2);
  });

  it("draws no action without edits: no link, no Ungroup, no group arrows, no Take out of group", () => {
    render(<TaskBoardView board={board()} />);
    expect(document.querySelector(".taskReadyLink, .taskReadyUngroup, [data-group-move], .taskMoveLeave, [draggable]")).toBeNull();
  });
});
