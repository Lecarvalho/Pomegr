import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AT, FakeChat, REPO_A, agentMessage, chatId, conversationOf, harness, installHarness, newUser, removeHarness, settle, userMessage } from "./agent-chat-fixture";

vi.mock("next/navigation", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { usePathname: () => harness.pathname };
});
vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  const { harness } = await import("./agent-chat-fixture");
  return { ...actual, useClientAccess: () => ({ mode: harness.mode, canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
});
vi.mock("../../app/tasks-store", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { useTasks: () => ({ board: harness.board, refresh: harness.refresh }) };
});
vi.mock("../../app/agents-client", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { useAgents: () => harness.agents };
});
vi.mock("../../app/repository-inventory-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/repository-inventory-client")>();
  const { harness } = await import("./agent-chat-fixture");
  return { ...actual, useRepositoryInventory: () => harness.inventory };
});

import { AgentChatDock } from "../../app/components/agent-chat/AgentChatDock";
import { parseTiming } from "../../app/agent-chat-client";
import { SUMMARIZED_LINE, answerTimeTitle, fullMessageTime, prepareLine, timingLine } from "../../app/components/agent-chat/agent-chat-presentation";

// The thread of a repository that was summarized for Aril shows one quiet line where the summary ends, and a measured answer's time
// shows its timing in the tooltip. The desktop tells where the summary ends and never what it says.
let chat: FakeChat;
const launcher = () => screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });

beforeEach(() => { chat = installHarness(); });
afterEach(() => { removeHarness(); });

const minute = (index: number) => `2026-10-11T09:${String(index).padStart(2, "0")}:00.000Z`;
const at = (message: Record<string, unknown>, index: number) => ({ ...message, at: minute(index) });
const TIMING = { eventMs: 1_200, textMs: 6_800, doneMs: 11_400, prompt: { instructions: 24_000, board: 18_000, taskLog: 300, conversation: 9_000, message: 52, other: 1_800 } };
const PREPARE = { total: 3_200, board: 120, root: 90, github: 2_900, workflow: 480, worktrees: 640, environment: 1_100 };

function seedFour(extra: Record<string, unknown> = {}) {
  chat.seed(REPO_A, conversationOf(1, [
    at(userMessage("First question", "m-1"), 1), at(agentMessage("First answer", {}, "m-2"), 2),
    at(userMessage("Second question", "m-3"), 3), at(agentMessage("Second answer", extra, "m-4"), 4),
  ]));
}
async function open() {
  render(<AgentChatDock />);
  await newUser().click(launcher());
  await settle();
}
/** The log's lines in order: a message by who wrote it, a quiet line by its words. */
const lines = () => [...log().children].map((child) => (child.classList.contains("agentChatQuietLine") ? `line:${child.querySelector(".agentChatQuietText")?.textContent}` : child.getAttribute("aria-label")));

describe("the line where the thread was summarized", () => {
  it("is drawn after the newest message the summary covers, with an icon, fixed words, and the time the summary was written", async () => {
    seedFour();
    chat.summarized = { through: { conversationId: chatId(1), messageId: "m-2", at: minute(2) }, at: "2026-10-11T09:30:00.000Z" };
    await open();
    expect(lines()).toEqual(["You", "Aril", `line:${SUMMARIZED_LINE}`, "You", "Aril"]);
    expect(SUMMARIZED_LINE).toBe("Earlier messages summarized for Aril");
    const line = log().querySelector(".agentChatQuietLine")!;
    expect(line.querySelector("svg.commandIcon")).not.toBeNull();
    expect(line.querySelector("time")).toHaveAttribute("datetime", "2026-10-11T09:30:00.000Z");
    expect(line.querySelector("time")).toHaveAttribute("title", expect.stringMatching(/\d/));
    // It is no message: no head, no bubble, no card, and no address of a message.
    expect(line.querySelector(".agentChatMessageHead")).toBeNull();
    expect(line.getAttribute("data-message-id")).toBeNull();
    expect(within(log() as HTMLElement).getAllByRole("article")).toHaveLength(4);
  });

  it("is drawn once, at the end of the thread when the summary covers the newest message, and never when the thread was not summarized", async () => {
    seedFour();
    chat.summarized = { through: { conversationId: chatId(1), messageId: "m-4", at: minute(4) }, at: "2026-10-11T09:30:00.000Z" };
    await open();
    expect(lines()).toEqual(["You", "Aril", "You", "Aril", `line:${SUMMARIZED_LINE}`]);
  });

  it("is not drawn for a thread that has no summary", async () => {
    seedFour();
    await open();
    expect(lines()).toEqual(["You", "Aril", "You", "Aril"]);
    expect(screen.queryByText(SUMMARIZED_LINE)).toBeNull();
  });

  it("waits for the older page that holds the message it follows, and then appears there", async () => {
    chat.pageSize = 2;
    seedFour();
    chat.summarized = { through: { conversationId: chatId(1), messageId: "m-2", at: minute(2) }, at: "2026-10-11T09:30:00.000Z" };
    await open();
    // The page holds the last two messages; the line belongs above them, where the owner has not scrolled yet.
    expect(lines()).toEqual(["You", "Aril"]);
    expect(screen.queryByText(SUMMARIZED_LINE)).toBeNull();
  });

  it("falls back to the last message before the time it ends at when the message itself is gone", async () => {
    seedFour();
    chat.summarized = { through: { conversationId: chatId(9), messageId: "m-1", at: minute(3) }, at: "2026-10-11T09:30:00.000Z" };
    await open();
    expect(lines()).toEqual(["You", "Aril", `line:${SUMMARIZED_LINE}`, "You", "Aril"]);
  });

  it("is read again when a compaction finishes while the panel sits idle, and the thread does not otherwise change", async () => {
    seedFour();
    await open();
    expect(screen.queryByText(SUMMARIZED_LINE)).toBeNull();
    const reads = chat.calls("thread").length;
    chat.summarized = { through: { conversationId: chatId(1), messageId: "m-2", at: minute(2) }, at: "2026-10-11T09:30:00.000Z" };
    await settle(5_000);
    expect(chat.calls("thread").length).toBe(reads + 1);
    expect(lines()).toEqual(["You", "Aril", `line:${SUMMARIZED_LINE}`, "You", "Aril"]);
    // Nothing new: the idle list asks, and the thread is not read again.
    await settle(10_000);
    expect(chat.calls("thread").length).toBe(reads + 1);
  });

  it("is read from an answer that holds only a position and a time, and nothing else is drawn from it", async () => {
    seedFour();
    // A desktop that put text in the answer would not have it drawn: the line's words are fixed.
    chat.summarized = { through: { conversationId: chatId(1), messageId: "m-2", at: minute(2) }, at: "2026-10-11T09:30:00.000Z", text: "SECRET SUMMARY" } as never;
    await open();
    expect(document.body.textContent).not.toContain("SECRET SUMMARY");
    expect(screen.getByText(SUMMARIZED_LINE)).toBeVisible();
  });
});

describe("the time of a measured answer", () => {
  it("adds the timing to its tooltip, and an answer without one keeps the plain date and time", async () => {
    seedFour({ timing: TIMING });
    await open();
    const answers = within(log()).getAllByRole("article", { name: "Aril" });
    const plain = answers[0].querySelector("time")!;
    const measured = answers[1].querySelector("time")!;
    expect(plain.getAttribute("title")).toBe(fullMessageTime(minute(2)));
    expect(measured.getAttribute("title")).toBe([fullMessageTime(minute(4)), "Started 1.2s · first words 6.8s · done 11.4s"].join("\n"));
    // The text of the time itself stays the clock.
    expect(measured.textContent).toMatch(/[0-9]{2}:[0-9]{2}$/u);
  });

  it("is built from numbers alone, leaves out a step the run never reached, and reads none from a record outside the contract", () => {
    expect(timingLine(TIMING)).toBe("Started 1.2s · first words 6.8s · done 11.4s");
    expect(timingLine({ ...TIMING, eventMs: null })).toBe("first words 6.8s · done 11.4s");
    expect(timingLine({ ...TIMING, eventMs: null, textMs: null })).toBe("done 11.4s");
    expect(timingLine({ ...TIMING, doneMs: 0, eventMs: 0, textMs: 0 })).toBe("Started 0.0s · first words 0.0s · done 0.0s");
    expect(timingLine(null)).toBeNull();
    expect(timingLine(undefined)).toBeNull();
    expect(answerTimeTitle(AT, null)).toBe(answerTimeTitle(AT));
    expect(answerTimeTitle(AT, TIMING)!.split("\n")).toEqual([answerTimeTitle(AT)!, "Started 1.2s · first words 6.8s · done 11.4s"]);
    expect(answerTimeTitle("not a time", TIMING)).toBeNull();
    expect(parseTiming(TIMING)).toEqual(TIMING);
    for (const bad of [null, "slow", [], { ...TIMING, doneMs: -1 }, { ...TIMING, doneMs: 1.5 }, { ...TIMING, doneMs: 3_600_001 }, { ...TIMING, eventMs: "1" }, { ...TIMING, textMs: undefined },
      { ...TIMING, prompt: null }, { ...TIMING, prompt: { ...TIMING.prompt, board: -1 } }, { ...TIMING, prompt: { ...TIMING.prompt, other: undefined } }]) {
      expect(parseTiming(bad)).toBeNull();
    }
    expect(Object.keys(parseTiming({ ...TIMING, extra: "a prompt", prompt: { ...TIMING.prompt, text: "a prompt" } })!.prompt)).toEqual(["instructions", "board", "taskLog", "conversation", "message", "other"]);
  });

  it("adds the preparation above the run's timing, and names the slowest step when it took a tenth of a second or more", async () => {
    seedFour({ timing: { ...TIMING, prepare: PREPARE } });
    await open();
    const measured = within(log()).getAllByRole("article", { name: "Aril" })[1].querySelector("time")!;
    expect(measured.getAttribute("title")).toBe([fullMessageTime(minute(4)), "Prepared in 3.2s (slowest: GitHub 2.9s)", "Started 1.2s · first words 6.8s · done 11.4s"].join("\n"));
    expect(prepareLine({ ...TIMING, prepare: PREPARE })).toBe("Prepared in 3.2s (slowest: GitHub 2.9s)");
    expect(prepareLine({ ...TIMING, prepare: { total: 400, workflow: 140, worktrees: 140, server: 60 } })).toBe("Prepared in 0.4s (slowest: workflow files 0.1s)");
    expect(prepareLine({ ...TIMING, prepare: { total: 90, board: 90, store: 5 } })).toBe("Prepared in 0.1s");
    expect(prepareLine({ ...TIMING, prepare: { total: 0 } })).toBe("Prepared in 0.0s");
    expect(prepareLine(TIMING)).toBeNull();
    expect(prepareLine(null)).toBeNull();
    expect(prepareLine(undefined)).toBeNull();
    expect(answerTimeTitle(AT, { ...TIMING, prepare: PREPARE })!.split("\n")).toEqual([answerTimeTitle(AT)!, "Prepared in 3.2s (slowest: GitHub 2.9s)", "Started 1.2s · first words 6.8s · done 11.4s"]);
    expect(answerTimeTitle(AT, TIMING)!.split("\n")).toEqual([answerTimeTitle(AT)!, "Started 1.2s · first words 6.8s · done 11.4s"]);
  });

  it("reads a preparation only inside its contract, and keeps the run's timing when the preparation is outside it", () => {
    expect(parseTiming({ ...TIMING, prepare: PREPARE })).toEqual({ ...TIMING, prepare: PREPARE });
    expect(parseTiming({ ...TIMING, prepare: { board: 10, total: 20 } })!.prepare).toEqual({ board: 10, total: 20 });
    expect(Object.hasOwn(parseTiming(TIMING)!, "prepare")).toBe(false);
    for (const bad of [null, "slow", [], 5, {}, { board: 10 }, { total: -1 }, { total: 1.5 }, { total: 3_600_001 }, { total: "20" }, { total: 20, board: 21 }, { total: 20, board: 1.5 },
      { total: 20, board: -1 }, { total: 20, board: "5" }, { total: 20, secret: 5 }, { total: 20, github: null }]) {
      const timing = parseTiming({ ...TIMING, prepare: bad });
      expect(timing, JSON.stringify(bad)).toEqual(TIMING);
      expect(Object.hasOwn(timing!, "prepare")).toBe(false);
    }
  });

  it("does not put the timing of a record outside the contract in the tooltip, and keeps the answer", async () => {
    seedFour({ timing: { ...TIMING, doneMs: -1 } });
    await open();
    const answers = within(log()).getAllByRole("article", { name: "Aril" });
    expect(answers[1]).toHaveTextContent("Second answer");
    expect(answers[1].querySelector("time")!.getAttribute("title")).not.toContain("done");
  });
});

void harness;
