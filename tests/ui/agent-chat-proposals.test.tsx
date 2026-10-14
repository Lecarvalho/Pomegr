import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EIGHT_OPERATIONS, FakeChat, PROPOSAL_ID, REPO_A, agentMessage, chatId, conversationOf, harness, installHarness, newUser, proposalOf, removeHarness, setBridge, settle, userMessage } from "./agent-chat-fixture";

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
    expect(rows[1]).toHaveTextContent("in Upload reliability · Claude Code · model-large · high · Complete when: PR open, CI passed · then add to queue");
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
    expect(rows[7]).toHaveTextContent("Run T-18, T-19, and T-20 in parallel");
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

describe("a proposed session start", () => {
  const START = [{ op: "start_session", id: "T-12" }];
  const withStart = (state = "pending", extra: Record<string, unknown> = {}) => chat.seed(REPO_A, conversationOf(1, [
    userMessage("start T-12"),
    agentMessage("I propose the start.", { proposal: { ...proposalOf(START, state, extra), summary: "Start a session for T-12." } }),
  ]));
  const card = () => within(log()).getByRole("region", { name: "Proposed session start" });
  const startButton = () => within(card()).getByRole("button", { name: "Start session" });
  const HELD = [{ ok: false, error: "not_started", start: "gate_held" }];

  it("is drawn as a start that has not happened: the task, Start session, and a line that nothing starts yet", async () => {
    withStart();
    render(<AgentChatDock />);
    await openPanel();
    expect(within(log()).queryByRole("region", { name: "Proposed board changes" })).toBeNull();
    const rows = within(card()).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Start a session for T-12");
    expect(rows[0].querySelector("code.agentChatTaskId")).toHaveTextContent("T-12");
    expect(rows[0].querySelector(".agentChatOpText.isMuted")).toHaveTextContent("Log upload retries");
    expect(rows[0].querySelector(".agentChatOpResult")).toBeNull();
    expect(card().querySelector(".commandChip")).toBeNull();
    expect(startButton()).toHaveClass("commandPrimaryAction");
    expect(within(card()).queryByRole("button", { name: "Apply changes" })).toBeNull();
    expect(within(card()).getByRole("button", { name: "Dismiss" })).toHaveClass("commandQuietAction");
    expect(within(card()).getByText("Nothing starts until you select Start session. Pomegr then checks the start gates and opens a terminal on this computer.")).toBeInTheDocument();
    expect(card()).not.toHaveTextContent(/Session started/);
    expect(chat.calls("apply")).toEqual([]);
  });

  it("says the session launched only after the desktop answered so, then offers no second start", async () => {
    withStart();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(startButton());
    await settle();
    expect(chat.calls("apply")).toEqual([{ repositoryId: REPO_A, conversationId: chatId(1), proposalId: PROPOSAL_ID }]);
    expect(card().querySelector(".commandChip")).toHaveTextContent("Session started");
    expect(card().querySelector(".commandChip")).toHaveClass("positive");
    const result = card().querySelector(".agentChatOpResult");
    expect(result).toHaveTextContent("Session started in a new terminal window.");
    expect(result).toHaveClass("is-ok");
    expect(within(card()).queryByRole("button", { name: "Start session" })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(within(card()).queryByText(/Nothing starts until/)).toBeNull();
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows a held start as not started, with the gates the board reads now, and keeps Start session for another try", async () => {
    harness.board = { ...harness.board, queue: { ...harness.board.queue, gates: {
      threshold: 85, usage: { claude: { status: "over", fiveHourPercent: 91, sevenDayPercent: 40 }, codex: { status: "ok", fiveHourPercent: 10, sevenDayPercent: 5 } },
      providerStatus: { claude: "ok", codex: "ok" }, workingTree: "unknown", next: null,
    } } };
    chat.startStatus = "gate_held";
    withStart();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(startButton());
    await settle();
    expect(card().querySelector(".commandChip")).toBeNull();
    const result = card().querySelector(".agentChatOpResult");
    expect(result).toHaveTextContent("Not started. A start gate held this task.");
    expect(result).toHaveClass("is-error");
    expect(within(card()).getByText("This task is held: Claude Code is above 85% of the five-hour window; the working tree state is not known yet.")).toBeInTheDocument();
    expect(card()).not.toHaveTextContent(/Session started/);
    expect(startButton()).toBeEnabled();
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    // The owner applies again once the gate is clear, and only that launch settles the card.
    chat.startStatus = "started";
    await person.click(startButton());
    await settle();
    expect(chat.calls("apply")).toHaveLength(2);
    expect(card().querySelector(".commandChip")).toHaveTextContent("Session started");
    expect(within(card()).queryByRole("button", { name: "Start session" })).toBeNull();
  });

  it("names a held start without a gate line when the board reads no hold now", async () => {
    withStart("pending", { results: HELD });
    render(<AgentChatDock />);
    await openPanel();
    expect(card().querySelector(".agentChatOpResult")).toHaveTextContent("Not started. A start gate held this task.");
    expect(within(card()).queryByText(/This task is held/)).toBeNull();
    expect(startButton()).toBeEnabled();
  });

  it("has one fixed line for every way a start did not happen", async () => {
    const lines: Record<string, string> = {
      unsupported_platform: "Not started. Starting sessions is available on Windows only.",
      cli_missing: "Not started. The provider's command-line tool was not found on this computer.",
      plugin_missing: "Not started. Install or update the Pomegr plugin in this repository to start sessions.",
      not_startable: "Not started. This task could not be started: it has a session, an outcome, or a start already under way.",
      gate_held: "Not started. A start gate held this task.",
      unsupported_provider: "Not started. Sessions cannot be started on this provider.",
      not_found: "Not started. This task no longer exists.",
      busy: "Not started. Another session was being started.",
      invalid: "Not started. The session could not be started.",
      unavailable: "Not started. The session could not be started.",
      failed: "Not started. The session could not be started.",
      worktree_dirty: "Not started. This task's worktree had uncommitted changes, and Pomegr never removes them.",
      tree_dirty: "Not started. This repository had uncommitted changes. Commit or discard them, or open the task to start it in a separate worktree.",
    };
    for (const [start, line] of Object.entries(lines)) {
      installHarness();
      chat = harness.chat;
      withStart("pending", { results: [{ ok: false, error: "not_started", start }] });
      const view = render(<AgentChatDock />);
      await openPanel();
      expect(card().querySelector(".agentChatOpResult"), start).toHaveTextContent(line);
      expect(card().querySelector(".agentChatOpResult"), start).toHaveClass("is-error");
      view.unmount();
    }
  });

  it("drops a start result outside the fixed statuses instead of drawing it", async () => {
    withStart("pending", { results: [{ ok: false, error: "not_started", start: "C:\\private\\repo" }] });
    render(<AgentChatDock />);
    await openPanel();
    expect(card().querySelector(".agentChatOpResult")).toBeNull();
    expect(card()).not.toHaveTextContent("private");
  });

  it("changes nothing when the desktop cancels the start", async () => {
    chat.startStatus = "cancelled";
    withStart();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(startButton());
    await settle();
    expect(card().querySelector(".agentChatOpResult")).toBeNull();
    expect(card().querySelector(".commandChip")).toBeNull();
    expect(startButton()).toBeEnabled();
  });

  it("offers no start on a paired device, only Dismiss and where the start can be applied", async () => {
    setBridge(undefined);
    harness.mode = "lan";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { operation: string; payload: Record<string, unknown> };
      return new Response(JSON.stringify(await chat.agentChat(body.operation, body.payload)), { status: 200, headers: { "content-type": "application/json" } });
    }));
    withStart();
    render(<AgentChatDock />);
    await openPanel();
    expect(await within(log()).findByRole("region", { name: "Proposed session start" })).toBeInTheDocument();
    expect(within(card()).queryByRole("button", { name: "Start session" })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Apply changes" })).toBeNull();
    expect(within(card()).getByRole("button", { name: "Dismiss" })).toBeEnabled();
    expect(within(card()).getByText("Aril's start can be applied only in the Pomegr desktop app. To start from this device, open the task and select Start session.")).toBeInTheDocument();
    expect(chat.calls("apply")).toEqual([]);
  });

  it("says where a start can be applied when the desktop refuses one", async () => {
    withStart();
    chat.refuse = "desktop_only";
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(startButton());
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("A session can be started from this chat only in the Pomegr desktop app.");
    expect(card().querySelector(".commandChip")).toBeNull();
    expect(harness.refresh).not.toHaveBeenCalled();
  });
});

describe("a proposed queue change", () => {
  const withQueue = (on = true, state = "pending", extra: Record<string, unknown> = {}) => chat.seed(REPO_A, conversationOf(1, [
    userMessage(on ? "turn the queue on" : "turn the queue off"),
    agentMessage("I propose the change.", { proposal: { ...proposalOf([{ op: "set_queue", on }], state, extra), summary: on ? "Turn the queue on." : "Turn the queue off." } }),
  ]));
  const card = () => within(log()).getByRole("region", { name: "Proposed queue change" });
  const ON_NOTE = "Nothing changes until you select Turn queue on. Pomegr may then start queued tasks by itself on the computer that runs Pomegr, in Ready order, as each passes the start gates.";
  const OFF_NOTE = "Nothing changes until you select Turn queue off. No new task starts then, and running sessions continue.";
  const asPairedDevice = () => {
    setBridge(undefined);
    harness.mode = "lan";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { operation: string; payload: Record<string, unknown> };
      return new Response(JSON.stringify(await chat.agentChat(body.operation, body.payload)), { status: 200, headers: { "content-type": "application/json" } });
    }));
  };

  it("is drawn as a change that has not happened: the state, its own Primary, and what turning the queue on lets Pomegr do", async () => {
    withQueue();
    render(<AgentChatDock />);
    await openPanel();
    expect(within(log()).queryByRole("region", { name: "Proposed board changes" })).toBeNull();
    const rows = within(card()).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Turn the queue on");
    expect(rows[0].querySelector(".agentChatOpResult")).toBeNull();
    expect(card().querySelector(".commandChip")).toBeNull();
    expect(within(card()).getByRole("button", { name: "Turn queue on" })).toHaveClass("commandPrimaryAction");
    expect(within(card()).queryByRole("button", { name: "Apply changes" })).toBeNull();
    expect(within(card()).getByRole("button", { name: "Dismiss" })).toHaveClass("commandQuietAction");
    expect(within(card()).getByText(ON_NOTE)).toBeInTheDocument();
    expect(card()).not.toHaveTextContent(/Queue turned/);
    expect(chat.calls("apply")).toEqual([]);
  });

  it("names Off as its own state, with a line that running sessions continue", async () => {
    withQueue(false);
    render(<AgentChatDock />);
    await openPanel();
    expect(within(card()).getAllByRole("listitem")[0]).toHaveTextContent("Turn the queue off");
    expect(within(card()).getByRole("button", { name: "Turn queue off" })).toHaveClass("commandPrimaryAction");
    expect(within(card()).queryByRole("button", { name: "Turn queue on" })).toBeNull();
    expect(within(card()).getByText(OFF_NOTE)).toBeInTheDocument();
  });

  it("says the queue was turned on only after the desktop answered so, then offers no second change", async () => {
    withQueue();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(within(card()).getByRole("button", { name: "Turn queue on" }));
    await settle();
    expect(chat.calls("apply")).toEqual([{ repositoryId: REPO_A, conversationId: chatId(1), proposalId: PROPOSAL_ID }]);
    expect(card().querySelector(".commandChip")).toHaveTextContent("Applied");
    const result = card().querySelector(".agentChatOpResult");
    expect(result).toHaveTextContent("Queue turned on.");
    expect(result).toHaveClass("is-ok");
    expect(within(card()).queryByRole("button")).toBeNull();
    expect(within(card()).queryByText(/Nothing changes until/)).toBeNull();
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });

  it("says that a task holds a queue that was turned on", async () => {
    chat.queueAnswer = { status: "blocked" };
    withQueue();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(within(card()).getByRole("button", { name: "Turn queue on" }));
    await settle();
    const held = card().querySelector(".agentChatOpResult");
    expect(held).toHaveTextContent("Queue turned on. A stalled or blocked task holds it, so nothing starts until you resolve that task.");
    expect(held).toHaveClass("is-muted");
  });

  it("says that the queue was turned off", async () => {
    withQueue(false);
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(within(card()).getByRole("button", { name: "Turn queue off" }));
    await settle();
    expect(card().querySelector(".agentChatOpResult")).toHaveTextContent("Queue turned off.");
    expect(card().querySelector(".agentChatOpResult")).toHaveClass("is-ok");
  });

  it("shows a refused or unanswered change as not changed, and keeps the same Primary for another try", async () => {
    for (const [error, line] of [["conflict", "Queue not changed. Pomegr refused this change."], ["invalid", "Queue not changed. Pomegr refused this change."], ["unavailable", "Queue not changed. Pomegr did not answer. Try again."]]) {
      installHarness();
      chat = harness.chat;
      chat.queueAnswer = { error };
      withQueue();
      const person = user();
      const view = render(<AgentChatDock />);
      await openPanel(person);
      await person.click(within(card()).getByRole("button", { name: "Turn queue on" }));
      await settle();
      const result = card().querySelector(".agentChatOpResult");
      expect(result, error).toHaveTextContent(line);
      expect(result, error).toHaveClass("is-error");
      expect(card().querySelector(".commandChip")).toBeNull();
      expect(card()).not.toHaveTextContent(/Queue turned/);
      // The owner applies again, and only an accepted change settles the card.
      chat.queueAnswer = { status: "running" };
      await person.click(within(card()).getByRole("button", { name: "Turn queue on" }));
      await settle();
      expect(chat.calls("apply")).toHaveLength(2);
      expect(card().querySelector(".agentChatOpResult")).toHaveTextContent("Queue turned on.");
      expect(within(card()).queryByRole("button")).toBeNull();
      view.unmount();
    }
  });

  it("can be applied on a paired device, through the chat route", async () => {
    asPairedDevice();
    withQueue();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    expect(await within(log()).findByRole("region", { name: "Proposed queue change" })).toBeInTheDocument();
    expect(within(card()).getByText(ON_NOTE)).toBeInTheDocument();
    await person.click(within(card()).getByRole("button", { name: "Turn queue on" }));
    await settle();
    expect(chat.calls("apply")).toEqual([{ repositoryId: REPO_A, conversationId: chatId(1), proposalId: PROPOSAL_ID }]);
    expect(card().querySelector(".agentChatOpResult")).toHaveTextContent("Queue turned on.");
  });

  it("dismisses without changing the queue", async () => {
    withQueue();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(within(card()).getByRole("button", { name: "Dismiss" }));
    await settle();
    expect(chat.calls("apply")).toEqual([]);
    expect(card().querySelector(".commandChip")).toHaveTextContent("Dismissed");
    expect(card().querySelector(".agentChatOpResult")).toBeNull();
  });
});
