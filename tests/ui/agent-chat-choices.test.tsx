import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, agentMessage, conversationOf, installHarness, newUser, proposalOf, removeHarness, settle, userMessage } from "./agent-chat-fixture";
import { renderDock } from "./dock-helper";

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

import { parseChoices } from "../../app/agent-chat-client";
import { choiceStates } from "../../app/components/agent-chat/agent-chat-choices";

// Quick replies and one multiple-choice question under Aril's newest answer. A tap sends the label as the owner's own message and does nothing else;
// once the owner has sent anything after the answer, the choices are quiet text and the one that was picked is marked.
let chat: FakeChat;
const user = newUser;
const launcher = () => screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const field = () => screen.getByRole("textbox", { name: "Message Aril" });
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });
const composer = () => field().closest("form") as HTMLFormElement;

beforeEach(() => { chat = installHarness(); });
afterEach(() => { removeHarness(); });

const REPLIES = { replies: ["Squash", "Merge commit", "Tell me more"] };
const QUESTION = {
  question: "Which merge method should this repository use?",
  options: [
    { label: "Squash", detail: "One commit for each pull request, as the history shows." },
    { label: "Merge commit", detail: "Keeps every commit; the history is busier." },
  ],
};
const minute = (index: number) => `2026-10-11T09:${String(index).padStart(2, "0")}:00.000Z`;
const at = (message: Record<string, unknown>, index: number) => ({ ...message, at: minute(index) });

function seedAsk(choices: unknown, extra: Record<string, unknown> = {}) {
  chat.seed(REPO_A, conversationOf(1, [at(userMessage("How do I merge?", "m-1"), 1), at(agentMessage("Squash fits this repository.", { choices, ...extra }, "m-2"), 2)]));
}
async function open(person = user()) {
  await renderDock();
  await person.click(launcher());
  await settle();
  return person;
}
const replies = () => within(log()).getByRole("list", { name: "Quick replies" });
const buttonsOf = (root: HTMLElement) => within(root).queryAllByRole("button").map((button) => button.textContent);

describe("quick replies", () => {
  it("are small Quiet buttons under the newest answer, and a tap sends the label as the owner's own message with the composer's run", async () => {
    seedAsk(REPLIES);
    const person = await open();
    const list = replies();
    expect(buttonsOf(list)).toEqual(["Squash", "Merge commit", "Tell me more"]);
    for (const button of within(list).getAllByRole("button")) expect(button).toHaveClass("commandQuietAction", "agentChatReply");
    // The choices sit inside Aril's answer, after its text.
    const article = list.closest("article")!;
    expect(article).toHaveAttribute("aria-label", "Aril");
    expect(article.querySelector(".agentChatMarkdown")!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The owner changes the effort first: the tap sends with what the composer shows.
    await person.click(within(composer()).getByRole("combobox", { name: "Effort" }));
    await person.click(screen.getByRole("option", { name: "High" }));
    await person.type(field(), "a draft in the field");
    await person.click(within(list).getByRole("button", { name: "Merge commit" }));
    await settle();
    expect(chat.calls("send")).toHaveLength(1);
    expect(chat.calls("send")[0]).toMatchObject({ repositoryId: REPO_A, conversationId: null, text: "Merge commit", provider: "claude", model: "model-large", effort: "high" });
    expect(Object.keys(chat.calls("send")[0]!)).not.toContain("images");
    // It is the owner's message in the thread, and the draft is untouched.
    expect(within(log()).getAllByRole("article", { name: "You" }).at(-1)).toHaveTextContent("Merge commit");
    expect(field()).toHaveValue("a draft in the field");
    // Nothing but the send happened: no apply, dismiss, or stop.
    expect(chat.calls("apply")).toHaveLength(0);
    expect(chat.calls("dismiss")).toHaveLength(0);
    expect(chat.calls("stop")).toHaveLength(0);
  });

  it("turn quiet once the owner has sent anything, and mark the one that was picked", async () => {
    seedAsk(REPLIES);
    const person = await open();
    await person.click(within(replies()).getByRole("button", { name: "Squash" }));
    await settle();
    chat.finish("Squash it is.");
    await settle(1_000);
    const quiet = within(log()).getByRole("list", { name: "Quick replies, answered" });
    expect(within(quiet).queryAllByRole("button")).toHaveLength(0);
    expect(quiet.textContent).toBe("SquashChosenMerge commitTell me more");
    expect(quiet.querySelector(".isPicked")).toHaveTextContent("Squash");
    expect(quiet.querySelectorAll(".isPicked")).toHaveLength(1);
    expect(within(log()).queryByRole("list", { name: "Quick replies" })).toBeNull();
  });

  it("turn quiet with nothing picked when the owner types an answer of their own", async () => {
    seedAsk(REPLIES);
    const person = await open();
    await person.type(field(), "Rebase, please");
    await person.keyboard("{Enter}");
    await settle();
    chat.finish("Rebase then.");
    await settle(1_000);
    const quiet = within(log()).getByRole("list", { name: "Quick replies, answered" });
    expect(within(quiet).queryAllByRole("button")).toHaveLength(0);
    expect(quiet.querySelector(".isPicked")).toBeNull();
    expect(quiet.textContent).toBe("SquashMerge commitTell me more");
  });

  it("send one message only: once it is on its way nothing under the answer can be tapped", async () => {
    seedAsk(REPLIES);
    const person = await open();
    await person.click(within(replies()).getByRole("button", { name: "Tell me more" }));
    await settle();
    // The turn is running: the owner's message is already after the answer, so the choices are quiet and nothing can be tapped.
    expect(within(log()).queryAllByRole("button", { name: "Squash" })).toHaveLength(0);
    expect(chat.calls("send")).toHaveLength(1);
  });

  it("are disabled, not hidden, under the newest answer while a turn of another message runs", async () => {
    seedAsk(REPLIES);
    const person = await open();
    // A turn started elsewhere (a follow-up, or another device) while this answer is still the newest.
    chat.turn = { repositoryId: REPO_A, conversationId: "chat-000000000001", startedAt: minute(3), provider: "claude", model: null, activity: "thinking", text: "" };
    await settle(6_000);
    const list = replies();
    for (const button of within(list).getAllByRole("button")) expect(button).toBeDisabled();
    await person.click(within(list).getByRole("button", { name: "Squash" }));
    expect(chat.calls("send")).toHaveLength(0);
    chat.turn = null;
    await settle(6_000);
    for (const button of within(replies()).getAllByRole("button")) expect(button).toBeEnabled();
  });

  it("are active only under the newest answer, and the older ones are quiet", async () => {
    chat.seed(REPO_A, conversationOf(1, [
      at(userMessage("First", "m-1"), 1), at(agentMessage("Older answer.", { choices: { replies: ["Old yes", "Old no"] } }, "m-2"), 2),
      at(userMessage("Old yes", "m-3"), 3), at(agentMessage("Newer answer.", { choices: { replies: ["New yes", "New no"] } }, "m-4"), 4),
    ]));
    await open();
    expect(buttonsOf(within(log()).getByRole("list", { name: "Quick replies" }))).toEqual(["New yes", "New no"]);
    const quiet = within(log()).getByRole("list", { name: "Quick replies, answered" });
    expect(quiet.textContent).toBe("Old yesChosenOld no");
    expect(buttonsOf(quiet)).toEqual([]);
  });

  it("are reachable with the keyboard, and a tap by key keeps focus in the message field", async () => {
    seedAsk(REPLIES);
    const person = await open();
    const squash = within(replies()).getByRole("button", { name: "Squash" });
    squash.focus();
    expect(squash).toHaveFocus();
    await person.tab();
    expect(within(replies()).getByRole("button", { name: "Merge commit" })).toHaveFocus();
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")[0]).toMatchObject({ text: "Merge commit" });
    expect(field()).toHaveFocus();
  });

  it("show an answer with no choices as before, and drop choices outside the contract while keeping the text", async () => {
    chat.seed(REPO_A, conversationOf(1, [
      at(userMessage("Q", "m-1"), 1),
      at(agentMessage("An answer with five replies.", { choices: { replies: ["1", "2", "3", "4", "5"] } }, "m-2"), 2),
    ]));
    await open();
    expect(within(log()).getByText("An answer with five replies.")).toBeInTheDocument();
    expect(within(log()).queryAllByRole("button")).toHaveLength(0);
    expect(log().querySelector(".agentChatReplies, .agentChatQuestion")).toBeNull();
  });

  it("are never drawn on a grant follow-up line or beside a proposal", async () => {
    chat.seed(REPO_A, conversationOf(1, [
      at(userMessage("Q", "m-1"), 1),
      at(agentMessage("Here is a plan.", { choices: REPLIES, proposal: proposalOf([{ op: "queue_task", id: "T-12" }]) }, "m-2"), 2),
    ]));
    chat.seed(REPO_A, conversationOf(2, [at(agentMessage("Merged T-5.", { grantFollowUp: true, choices: REPLIES }, "m-1"), 3)], { grantFollowUps: true }));
    await open();
    expect(within(log()).getByRole("region", { name: "Proposed board changes" })).toBeInTheDocument();
    expect(within(log()).queryByRole("list", { name: "Quick replies" })).toBeNull();
    expect(log().querySelector(".agentChatReplies")).toBeNull();
  });

  it("stay active under an answer when a grant follow-up line comes after it", async () => {
    chat.seed(REPO_A, conversationOf(1, [at(userMessage("Q", "m-1"), 1), at(agentMessage("Squash fits.", { choices: REPLIES }, "m-2"), 2)]));
    chat.seed(REPO_A, conversationOf(2, [at(agentMessage("Merged T-5.", { grantFollowUp: true }, "m-1"), 3)], { grantFollowUps: true }));
    await open();
    expect(buttonsOf(replies())).toEqual(["Squash", "Merge commit", "Tell me more"]);
  });
});

describe("a multiple-choice question", () => {
  it("is a list under the answer with one row for each option, its label and one-line detail, and the first one marked Recommended", async () => {
    seedAsk(QUESTION);
    await open();
    const group = within(log()).getByRole("group", { name: QUESTION.question });
    expect(group).toHaveTextContent(QUESTION.question);
    const rows = within(group).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [first, second] = rows.map((row) => within(row).getByRole("button"));
    for (const row of [first, second]) expect(row).toHaveClass("commandQuietAction", "agentChatChoice");
    expect(first.querySelector(".agentChatChoiceLabel")).toHaveTextContent("SquashRecommended");
    expect(first.querySelector(".commandChip")).toHaveTextContent("Recommended");
    expect(first.querySelector(".agentChatChoiceDetail")).toHaveTextContent("One commit for each pull request, as the history shows.");
    expect(second.querySelector(".commandChip")).toBeNull();
    expect(second.querySelector(".agentChatChoiceDetail")).toHaveTextContent("Keeps every commit; the history is busier.");
    // There is no option for a free answer: the composer is the free answer.
    expect(within(group).getAllByRole("button")).toHaveLength(2);
  });

  it("sends the label of the row that was tapped, and then shows that row as chosen", async () => {
    seedAsk(QUESTION);
    const person = await open();
    await person.click(within(within(log()).getByRole("group", { name: QUESTION.question })).getByRole("button", { name: /^Merge commit/ }));
    await settle();
    expect(chat.calls("send")[0]).toMatchObject({ text: "Merge commit", provider: "claude" });
    chat.finish("Merge commit it is.");
    await settle(1_000);
    const group = within(log()).getByRole("group", { name: QUESTION.question });
    expect(within(group).queryAllByRole("button")).toHaveLength(0);
    const rows = within(group).getAllByRole("listitem");
    expect(rows[0].querySelector(".isPicked")).toBeNull();
    expect(rows[0].querySelector(".commandChip")).toHaveTextContent("Recommended");
    expect(rows[1].querySelector(".isPicked")).not.toBeNull();
    expect(rows[1].querySelector(".commandChip")).toHaveTextContent("Chosen");
    expect(rows[1]).toHaveTextContent("Keeps every commit; the history is busier.");
  });
});

describe("the choices of an answer as the client reads them", () => {
  it("accepts the stored shapes and nothing else", () => {
    expect(parseChoices(REPLIES)).toEqual(REPLIES);
    expect(parseChoices(QUESTION)).toEqual(QUESTION);
    expect(parseChoices({ replies: [" Squash "] })).toEqual({ replies: ["Squash"] });
    for (const bad of [
      null, undefined, "Squash", [], {}, { replies: [] }, { replies: ["1", "2", "3", "4", "5"] }, { replies: ["a".repeat(41)] }, { replies: ["Yes", "yes"] }, { replies: ["a\nb"] }, { replies: ["a\u2028b"] },
      { replies: [1] }, { replies: ["Yes"], extra: 1 }, { replies: ["Yes"], ...QUESTION },
      { ...QUESTION, options: [QUESTION.options[0]] }, { ...QUESTION, options: [...QUESTION.options, ...QUESTION.options, QUESTION.options[0]] },
      { ...QUESTION, question: "q".repeat(121) }, { ...QUESTION, options: [{ ...QUESTION.options[0], label: "l".repeat(61) }, QUESTION.options[1]] },
      { ...QUESTION, options: [{ ...QUESTION.options[0], detail: "d".repeat(121) }, QUESTION.options[1]] }, { ...QUESTION, options: [{ label: "A" }, QUESTION.options[1]] },
      { ...QUESTION, options: [{ ...QUESTION.options[0], recommended: true }, QUESTION.options[1]] }, { ...QUESTION, options: [{ ...QUESTION.options[0], label: "SQUASH" }, QUESTION.options[0]] },
    ]) expect(parseChoices(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("which choices can be tapped", () => {
  const thread = (...messages: Record<string, unknown>[]) => messages.map((message, index) => ({ conversationId: "chat-000000000001", id: `m-${index + 1}`, at: minute(index), ...message })) as never;
  const ask = { role: "agent", text: "A", provider: "claude", model: null, status: "complete", choices: REPLIES };

  it("keys each answer's state by conversation and message, and reads the owner's next message as the pick", () => {
    const messages = thread({ role: "user", text: "Q" }, ask, { role: "user", text: " Squash " }, { ...ask, choices: { replies: ["Yes"] } });
    const states = choiceStates(messages, null, false);
    expect(states.get("chat-000000000001/m-2")).toEqual({ mode: "past", picked: "Squash" });
    expect(states.get("chat-000000000001/m-4")).toEqual({ mode: "active", picked: null });
    expect(choiceStates(messages, null, true).get("chat-000000000001/m-4")).toEqual({ mode: "waiting", picked: null });
  });

  it("treats a message on its way as the owner's reply, and a newer answer as closing the older choices", () => {
    const messages = thread({ role: "user", text: "Q" }, ask);
    expect(choiceStates(messages, "Tell me more", true).get("chat-000000000001/m-2")).toEqual({ mode: "past", picked: "Tell me more" });
    expect(choiceStates(messages, "Something else", true).get("chat-000000000001/m-2")).toEqual({ mode: "past", picked: null });
    const superseded = thread({ role: "user", text: "Q" }, ask, { role: "agent", text: "B", provider: "claude", model: null, status: "complete" }, { role: "user", text: "Squash" });
    expect(choiceStates(superseded, null, false).get("chat-000000000001/m-2")).toEqual({ mode: "past", picked: null });
  });

  it("does not let a grant follow-up line close the choices before it", () => {
    const messages = thread({ role: "user", text: "Q" }, ask, { role: "agent", text: "Merged.", provider: "claude", model: null, status: "complete", grantFollowUp: true });
    expect(choiceStates(messages, null, false).get("chat-000000000001/m-2")).toEqual({ mode: "active", picked: null });
  });
});
