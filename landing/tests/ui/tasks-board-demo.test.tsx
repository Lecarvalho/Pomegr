// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TasksBoardDemo } from "../../app/docs/demos/TasksBoardDemo";
import { DEMO_COLUMNS, DEMO_STEPS } from "../../app/docs/demos/tasks-board-steps";

afterEach(cleanup);

const demo = () => screen.getByRole("region", { name: "Demo board · sample tasks" });
const caption = () => document.getElementById(demo().getAttribute("aria-describedby") ?? "")!;
const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name} [0-9]+$`) });
const cardIds = (name: string) => within(column(name)).queryAllByText(/^T-[0-9]+$/).map((node) => node.textContent);
const action = (name: string) => screen.getByRole("button", { name });
const queueState = () => screen.getByText("Queue").textContent;

describe("tasks board demo", () => {
  it("opens as a labelled demo whose caption says it is not the app", () => {
    render(<TasksBoardDemo />);
    expect(caption().textContent).toBe("This is a demo with sample tasks, not the Pomegr app. It starts nothing.");
    expect(caption().getAttribute("aria-live")).toBe("polite");
    for (const name of DEMO_COLUMNS) expect(column(name)).toBeTruthy();
    expect(cardIds("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
    expect(queueState()).toContain("Off");
  });

  it("walks every step in order, with one caption each, and starts over", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<TasksBoardDemo />);

    await user.click(action("New task"));
    expect(caption().textContent).toBe("Create task puts the new card in Backlog, not queued.");
    expect(cardIds("Backlog")).toEqual(["T-1", "T-2", "T-3", "T-4"]);

    await user.click(action("Add to queue"));
    expect(cardIds("Ready")).toEqual(["T-1", "T-2", "T-3"]);
    // The board leaves out the chip the lane already says: only the next card keeps one, worded Next.
    expect(within(column("Ready")).getByText("Next")).toBeTruthy();
    expect(within(column("Ready")).queryByText(/^Queued/)).toBeNull();
    expect(cardIds("Backlog")).toEqual(["T-4"]);

    await user.click(action("Run in parallel"));
    const group = within(column("Ready")).getByRole("list", { name: "Parallel group of 2" });
    expect(within(group).getAllByText(/^T-[0-9]+$/).map((node) => node.textContent)).toEqual(["T-2", "T-3"]);
    expect(within(column("Ready")).getByText("Parallel · 2")).toBeTruthy();
    expect(queueState()).toContain("Off");

    await user.click(action("Queue: On"));
    expect(queueState()).toContain("On");
    expect(cardIds("In progress")).toEqual(["T-1"]);
    expect(within(column("Ready")).getAllByText("Waiting: T-1 is running")).toHaveLength(2);

    await user.click(action("Continue"));
    expect(cardIds("Review")).toEqual(["T-1"]);
    expect(cardIds("In progress")).toEqual(["T-2", "T-3"]);
    expect(cardIds("Done")).toEqual([]);
    expect(screen.queryByRole("region", { name: "Aril" })).toBeNull();

    await user.click(action("Ask Aril"));
    const aril = screen.getByRole("region", { name: "Aril" });
    expect(within(aril).getByText("Create task")).toBeTruthy();
    expect(within(aril).getByText("Nothing changes until you apply.")).toBeTruthy();
    expect(cardIds("Backlog")).toEqual(["T-4"]);

    await user.click(action("Apply changes"));
    expect(cardIds("Backlog")).toEqual(["T-4", "T-5"]);
    expect(within(screen.getByRole("region", { name: "Aril" })).getByText("Applied")).toBeTruthy();
    expect(screen.getByText("Step 8 of 8")).toBeTruthy();

    await user.click(action("Start over"));
    expect(cardIds("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("announces each step's caption in the live region", async () => {
    const user = userEvent.setup();
    render(<TasksBoardDemo />);
    for (const [index, step] of DEMO_STEPS.entries()) {
      expect(caption().textContent).toBe(step.caption);
      if (index < DEMO_STEPS.length - 1) await user.click(action(step.action));
    }
  });

  it("is operated by keyboard and keeps focus on the step's control", async () => {
    const user = userEvent.setup();
    render(<TasksBoardDemo />);
    await user.tab();
    expect(document.activeElement).toBe(action("New task"));
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(action("Add to queue"));
    await user.keyboard(" ");
    expect(cardIds("Ready")).toEqual(["T-1", "T-2", "T-3"]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(action("Start over"));
    await user.keyboard("{Enter}");
    expect(cardIds("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("gives each step one short, distinct caption and uses only the sample tasks", () => {
    expect(DEMO_STEPS).toHaveLength(8);
    for (const step of DEMO_STEPS) {
      expect(step.caption.length).toBeLessThanOrEqual(110);
      for (const cards of Object.values(step.columns)) for (const card of cards) expect(card.id).toMatch(/^T-[1-5]$/);
    }
    expect(new Set(DEMO_STEPS.map((step) => step.caption)).size).toBe(DEMO_STEPS.length);
  });

  it("follows the board rule: a card has no chip where its lane already says the state, so only the next card of Ready has one", () => {
    for (const step of DEMO_STEPS) {
      for (const name of DEMO_COLUMNS) for (const card of step.columns[name]) if (card.chip) expect(name).toBe("Ready");
      expect(step.columns.Ready.filter((card) => card.chip === "Next").length).toBeLessThanOrEqual(1);
      // Review is the only lane with a card that needs the owner, and that card says so with its border, not a chip.
      for (const name of DEMO_COLUMNS) for (const card of step.columns[name]) expect(card.attention === true).toBe(name === "Review");
    }
  });

  it("draws no chip in Backlog, In progress, or Review, and an amber border on the card in Review", async () => {
    const user = userEvent.setup();
    render(<TasksBoardDemo />);
    await user.click(action("New task"));
    await user.click(action("Add to queue"));
    // The selector does find the one chip the board keeps, so the empty lanes below are not an empty search.
    expect(column("Ready").querySelector("[class*='chip']")).not.toBeNull();
    for (const step of DEMO_STEPS.slice(2, -1)) await user.click(action(step.action));
    expect(column("Backlog").querySelector("[class*='chip']")).toBeNull();
    expect(column("In progress").querySelector("[class*='chip']")).toBeNull();
    expect(column("Review").querySelector("[class*='chip']")).toBeNull();
    expect(screen.queryByText(/^(Not queued|Working|Needs review|Queued)/)).toBeNull();
    expect(within(column("Review")).getByText("T-1").closest("li")?.getAttribute("data-attention")).toBe("true");
    expect(within(column("In progress")).getByText("T-2").closest("li")?.getAttribute("data-attention")).toBeNull();
  });

  it("respects reduced motion and stacks the board when narrow", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../app/docs/demos/tasks-board-demo.module.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.card\[data-changed="true"\] \{ animation: none; \}/);
    expect(css).toMatch(/@container \(max-width: 560px\) \{\s*\.board \{ grid-template-columns: minmax\(0, 1fr\);/);
  });
});
