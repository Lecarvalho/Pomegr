import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EIGHT_OPERATIONS, FakeChat, PROPOSAL_ID, REPO_A, agentMessage, chatId, conversationOf, harness, installHarness, newUser, proposalOf, removeHarness, settle, userMessage } from "./agent-chat-fixture";

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

let chat: FakeChat;

beforeEach(() => { chat = installHarness(); });
afterEach(() => { removeHarness(); });

const user = newUser;
/** The repositories the chat asked about, once each, in order. */
const listed = () => [...new Set(chat.calls("list").map((payload) => payload.repositoryId))];
const launcher = () => screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const panel = () => screen.getByRole("region", { name: "Aril, the Pomegr agent" });
const field = () => screen.getByRole("textbox", { name: "Message Aril" });
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });
const sendButton = () => screen.getByRole("button", { name: "Send" });

async function openPanel(person = user()) {
  await person.click(launcher());
  await settle();
  return person;
}

async function ask(person: ReturnType<typeof user>, text: string) {
  await person.type(field(), text);
  await person.keyboard("{Enter}");
  await settle();
}

describe("proposals", () => {
  const withProposal = (operations = EIGHT_OPERATIONS, extra: Record<string, unknown> = {}) => chat.seed(REPO_A, conversationOf(1, [
    userMessage("Break the upload feature into tasks"),
    agentMessage("Here is the plan.", { proposal: proposalOf(operations, "pending", extra) }),
  ]));
  const card = () => within(log()).getByRole("region", { name: "Proposed board changes" });

  it("draws one row for each of the eight operations with fixed words, a first line of text and a muted line of what is set", async () => {
    withProposal();
    render(<AgentChatDock />);
    await openPanel();
    expect(within(card()).getByText("Cut the upload work into tasks.")).toBeInTheDocument();
    expect(card().querySelector(".commandChip")).toBeNull();
    const rows = within(card()).getAllByRole("listitem");
    expect(rows).toHaveLength(8);
    expect(rows[0]).toHaveTextContent("Create featureUpload reliability");
    expect(rows[1]).toHaveTextContent("Create task");
    expect(rows[1]).toHaveTextContent("Add retry with backoff to the upload client");
    expect(rows[1]).not.toHaveTextContent("Cover the 5xx");
    expect(rows[1].querySelector("[title]")?.getAttribute("title")).toBe("Add retry with backoff to the upload client\nCover the 5xx and timeout cases.");
    expect(rows[1]).toHaveTextContent("in Upload reliability · step 1 · Claude Code · model-large · high · Complete when: PR open, CI passed · then add to queue");
    expect(rows[2]).toHaveTextContent("Update T-12");
    expect(rows[2].querySelector("code.agentChatTaskId")).toHaveTextContent("T-12");
    // The board's current first line of that task, and only that line.
    expect(rows[2].querySelector(".agentChatOpText.isMuted")).toHaveTextContent("Log upload retries");
    expect(rows[2]).not.toHaveTextContent("Include the attempt number");
    expect(rows[2]).toHaveTextContent("Changes text, effort, feature");
    expect(rows[2]).toHaveTextContent("New text: Show the retry count in the upload log");
    expect(rows[3]).toHaveTextContent("Delete T-14");
    expect(rows[3]).toHaveTextContent("Remove the legacy uploader");
    expect(rows[3].querySelector(".agentChatOpWarning")).toHaveTextContent("Cannot be undone");
    expect(rows[4]).toHaveTextContent("Move T-15 to Review");
    expect(rows[4]).toHaveTextContent("position 1");
    expect(rows[5]).toHaveTextContent("Add T-16 to queue");
    expect(rows[6]).toHaveTextContent("Remove T-17 from queue");
    expect(rows[7]).toHaveTextContent("Move T-18 to step 2");
    for (const row of rows) expect(row.querySelector(".agentChatOpResult")).toBeNull();
    expect(within(card()).getByRole("button", { name: "Apply changes" })).toHaveClass("commandPrimaryAction");
    expect(within(card()).getByRole("button", { name: "Dismiss" })).toHaveClass("commandQuietAction");
    expect(within(card()).getByText("Nothing changes until you apply. Deleting cannot be undone.")).toBeInTheDocument();
  });

  it("omits the board's line for a task it does not hold, and the delete sentence for a proposal without a delete", async () => {
    withProposal([{ op: "update_task", id: "T-99", effort: undefined, run: { provider: "codex", model: null } }, { op: "queue_task", id: "T-12" }]);
    render(<AgentChatDock />);
    await openPanel();
    const rows = within(card()).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Update T-99");
    expect(rows[0].querySelector(".agentChatOpText")).toBeNull();
    expect(rows[0]).toHaveTextContent("Changes run on");
    expect(within(card()).getByText("Nothing changes until you apply.")).toBeInTheDocument();
  });

  it("applies, reads the conversation again, shows each result and the chip, and reads the board again", async () => {
    withProposal();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(within(card()).getByRole("button", { name: "Apply changes" }));
    await settle();
    expect(chat.calls("apply")).toEqual([{ repositoryId: REPO_A, conversationId: chatId(1), proposalId: PROPOSAL_ID }]);
    expect(card().querySelector(".commandChip")).toHaveTextContent("Applied");
    expect(card().querySelector(".commandChip")).toHaveClass("positive");
    const rows = within(card()).getAllByRole("listitem");
    expect(rows[1].querySelector(".agentChatOpResult")).toHaveTextContent("Created T-19");
    expect(rows[1].querySelector(".agentChatOpResult")).toHaveClass("is-ok");
    for (const index of [0, 2, 3, 4, 5, 6, 7]) expect(rows[index].querySelector(".agentChatOpResult")).toHaveTextContent("Done");
    expect(within(card()).queryByRole("button", { name: "Apply changes" })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(within(card()).queryByText(/Nothing changes until you apply/)).toBeNull();
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    // The conversation was read again after the answer.
    expect(chat.calls("read").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps both actions disabled and the card busy while the answer is in flight", async () => {
    withProposal();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = chat.agentChat.getMockImplementation()!;
    chat.agentChat.mockImplementation(async (operation, payload) => { if (operation === "apply") await gate; return original(operation, payload); });
    await person.click(within(card()).getByRole("button", { name: "Apply changes" }));
    await settle();
    expect(card()).toHaveAttribute("aria-busy", "true");
    expect(within(card()).getByRole("button", { name: "Apply changes" })).toBeDisabled();
    expect(within(card()).getByRole("button", { name: "Dismiss" })).toBeDisabled();
    release();
    await settle();
    expect(card()).not.toHaveAttribute("aria-busy");
  });

  it("dismisses without reading the board again", async () => {
    withProposal();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(within(card()).getByRole("button", { name: "Dismiss" }));
    await settle();
    expect(chat.calls("dismiss")).toEqual([{ repositoryId: REPO_A, conversationId: chatId(1), proposalId: PROPOSAL_ID }]);
    expect(card().querySelector(".commandChip")).toHaveTextContent("Dismissed");
    expect(card().querySelector(".commandChip")).not.toHaveClass("positive", "warning");
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it("names every result, a partly applied proposal's chip, and a task that was created but not queued", async () => {
    const results = [
      { ok: true }, { ok: false, error: "conflict", taskId: "T-19" }, { ok: false, error: "invalid" }, { ok: false, error: "not_found" },
      { ok: false, error: "limit" }, { ok: false, error: "unsupported" }, { ok: false, error: "unavailable" }, { ok: false, error: "skipped" },
    ];
    chat.seed(REPO_A, conversationOf(1, [userMessage("Go"), agentMessage("Plan", { proposal: proposalOf(EIGHT_OPERATIONS, "partial", { results }) })]));
    render(<AgentChatDock />);
    await openPanel();
    expect(card().querySelector(".commandChip")).toHaveTextContent("Partly applied");
    expect(card().querySelector(".commandChip")).toHaveClass("warning");
    const outcomes = [...card().querySelectorAll(".agentChatOpResult")];
    expect(outcomes.map((outcome) => outcome.textContent)).toEqual([
      "Done", "Created T-19, but it could not be queued", "Not valid", "Not found", "Board is full", "Not supported", "Pomegr did not answer", "Not run",
    ]);
    expect(outcomes.map((outcome) => outcome.className.match(/is-(\w+)/)?.[1])).toEqual(["ok", "error", "error", "error", "error", "error", "error", "muted"]);
    expect(within(card()).queryByRole("button", { name: "Apply changes" })).toBeNull();
  });

  it("answers a proposal that was already answered with one fixed line", async () => {
    withProposal();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    chat.refuse = "conflict";
    await person.click(within(card()).getByRole("button", { name: "Apply changes" }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("That proposal was already answered.");
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it("says that a proposal that could not be read leaves nothing to apply", async () => {
    chat.seed(REPO_A, conversationOf(1, [
      userMessage("Go"),
      agentMessage("Plan A", { proposalUnreadable: true }, "m-2"),
      agentMessage("Plan B", { proposal: { id: "not-a-proposal-id", summary: "Broken", operations: [] } }, "m-3"),
    ]));
    render(<AgentChatDock />);
    await openPanel();
    const notices = within(log()).getAllByText("Aril wrote a proposal that Pomegr could not read, so there is nothing to apply. Ask for it again.");
    expect(notices).toHaveLength(2);
    expect(notices[0]).toHaveClass("taskNotice", "warning");
    expect(within(log()).queryByRole("button", { name: "Apply changes" })).toBeNull();
    expect(within(log()).queryByRole("region", { name: "Proposed board changes" })).toBeNull();
  });

  it("draws the proposal's text and its tasks' text as plain text, never as markup", async () => {
    withProposal([{ op: "create_task", text: "<img src=x onerror=alert(1)> do it", feature: "<b>Bold</b>" }]);
    render(<AgentChatDock />);
    await openPanel();
    expect(card().querySelector("img, b, script")).toBeNull();
    expect(card()).toHaveTextContent("<img src=x onerror=alert(1)> do it");
    expect(card()).toHaveTextContent("in <b>Bold</b>");
  });
});
