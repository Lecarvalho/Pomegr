"use client";

import { useState, type ReactNode } from "react";
import type { AgentChatAgentMessage, AgentChatBoardOperation, AgentChatConversation, AgentChatOperationResult, AgentChatProposal, AgentChatTurn } from "../../../shared/agent-chat-contract";
import { AgentChatComposer } from "../agent-chat/AgentChatComposer";
import { AgentChatHeader, AgentChatLauncher, AgentChatPanelFrame, AgentChatRepositoryRow } from "../agent-chat/AgentChatFrame";
import { AgentChatHistory } from "../agent-chat/AgentChatHistory";
import { AgentChatMarkdown } from "../agent-chat/AgentChatMarkdown";
import { AgentChatMessages, type AgentChatLogState } from "../agent-chat/AgentChatMessages";
import { AgentChatProposalCard } from "../agent-chat/AgentChatProposalCard";
import { DEFAULT_RUN, NO_MODELS, runSelectOptions, runSelectValue } from "../tasks/task-fields";
import { Sample, Section } from "./DesignSystemKit";

// Static samples of the Aril chat: the real panel parts drawn from invented conversations. Nothing here reads a store.

const noop = () => undefined;
const AT = "2026-10-11T10:00:00.000Z";
const REPOSITORIES = [{ value: "repo-000000000000000000000001", label: "pomegr" }, { value: "repo-000000000000000000000002", label: "catalogus" }];
const RUN_OPTIONS = runSelectOptions({ ...NO_MODELS, claude: ["model-large", "model-small"], codex: ["model-code"] }, DEFAULT_RUN);
const TASKS = [{ id: "T-12", text: "Log upload retries\nInclude the attempt number." }, { id: "T-14", text: "Remove the legacy uploader" }];

const OPERATIONS: AgentChatBoardOperation[] = [
  { op: "create_feature", name: "Upload reliability" },
  { op: "create_task", text: "Add retry with backoff to the upload client\nCover the 5xx and timeout cases.", feature: "Upload reliability", run: { provider: "claude", model: "model-large", effort: "high" }, completeWhen: { checks: ["pr_open", "ci_passed"], own: null }, queue: true },
  { op: "update_task", id: "T-12", text: "Show the retry count in the upload log", run: { effort: "high" }, feature: "Upload reliability" },
  { op: "delete_task", id: "T-14" },
  { op: "move_task", id: "T-15", column: "Review", position: 0 },
  { op: "queue_task", id: "T-16" },
  { op: "unqueue_task", id: "T-17" },
  { op: "group_tasks", ids: ["T-18", "T-19", "T-20"] },
];

const SUMMARY = "Cut the upload work into a feature with one new task, and tidy three others.";
const proposal = (state: AgentChatProposal["state"], results?: AgentChatOperationResult[], operations = OPERATIONS): AgentChatProposal => ({ id: "p-0123456789ab", summary: SUMMARY, operations, state, ...(results ? { results } : {}) });
const OK: AgentChatOperationResult = { ok: true };
const skipped: AgentChatOperationResult = { ok: false, error: "skipped" };
const APPLIED = proposal("applied", [OK, { ok: true, taskId: "T-19" }, OK, OK, OK, OK, OK, OK]);
const PARTIAL = proposal("partial", [OK, { ok: false, error: "conflict", taskId: "T-19" }, skipped, skipped, skipped, skipped, skipped, skipped]);
const NOT_FOUND = proposal("partial", [OK, { ok: true, taskId: "T-19" }, { ok: false, error: "not_found" }, skipped, skipped, skipped, skipped, skipped]);
const EVERY_WORD = proposal("partial", [
  OK, { ok: true, taskId: "T-19" }, { ok: false, error: "invalid" }, { ok: false, error: "not_found" }, { ok: false, error: "limit" },
  { ok: false, error: "conflict" }, { ok: false, error: "unsupported" }, { ok: false, error: "unavailable" },
]);

const agent = (id: string, text: string, overrides: Partial<AgentChatAgentMessage> = {}): AgentChatAgentMessage => ({ id, role: "agent", text, at: AT, provider: "claude", model: "model-large", status: "complete", ...overrides });

function conversation(messages: AgentChatConversation["messages"]): AgentChatConversation {
  return { id: "chat-0123456789ab", title: "Plan the upload work", provider: "claude", model: "model-large", createdAt: AT, updatedAt: AT, messages };
}

const ANSWER = [
  "The upload client has **no retry**, and the log cannot show one. I would cut this into three tasks:",
  "",
  "1. Add retry with backoff to the client.",
  "2. Show the retry count in the upload log.",
  "- Keep each task under one session.",
  "",
  "```",
  "retry: 5 attempts, 200 ms base delay",
  "```",
].join("\n");

const ASK = { id: "m-1", role: "user" as const, text: "Break the upload feature into tasks.", at: AT };
const PROPOSED = conversation([ASK, agent("m-2", ANSWER, { proposal: proposal("pending") })]);
const STREAMING_TURN: AgentChatTurn = { conversationId: "chat-0123456789ab", startedAt: AT, provider: "claude", model: "model-large", activity: "reading_files", text: "I am reading the upload client and the board. The retry path is" };
const NOTES = conversation([
  ASK,
  agent("m-2", "I started to answer, then the run ended.", { status: "failed" }),
  { id: "m-3", role: "user", text: "Try again.", at: AT },
  agent("m-4", "", { status: "timed_out" }),
  agent("m-5", "The proposal below could not be read.", { proposalUnreadable: true }),
]);

const HISTORY = [
  { id: "chat-000000000001", title: "Plan the upload work", updatedAt: AT, messages: 4 },
  { id: "chat-000000000002", title: "Which model fits the cleanup tasks?", updatedAt: "2026-10-10T16:30:00.000Z", messages: 2 },
  { id: "chat-000000000003", title: "Is T-12 too big for one session?", updatedAt: "2026-10-09T09:15:00.000Z", messages: 1 },
];

function Wide({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="designSystemGrid"><Sample label={label} note={note}><div className="designSystemTaskFrame">{children}</div></Sample></div>;
}

// Two invented images: a 1×1 GIF as an inline `data:` URL. The second has no URL, so it draws as a pending frame.
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const IMAGE_ONE = "img-000000000001";
const IMAGE_TWO = "img-000000000002";
const IMAGE_URLS = new Map([[IMAGE_ONE, PIXEL], [IMAGE_TWO, PIXEL]]);
const PENDING_URLS = new Map([[IMAGE_ONE, PIXEL]]);
const sentImage = (id: string) => ({ id, type: "gif" as const, bytes: 43 });
const IMAGE_OPERATIONS: AgentChatBoardOperation[] = [
  { op: "create_task", text: "Fix the upload dialog layout", images: [IMAGE_ONE] },
  { op: "attach_images", id: "T-12", images: [IMAGE_TWO] },
];
const IMAGE_PROPOSAL = proposal("pending", undefined, IMAGE_OPERATIONS);
const IMAGE_FAILED = proposal("partial", [{ ok: true, taskId: "T-19" }, { ok: false, error: "limit", part: "images" }], IMAGE_OPERATIONS);
const WITH_IMAGES = conversation([
  { id: "m-1", role: "user", text: "The upload dialog looks wrong in both of these. Can you make a task for the first one and add the second to T-12?", at: AT, images: [sentImage(IMAGE_ONE), sentImage(IMAGE_TWO)] },
  agent("m-2", "I would create one task with the first image and attach the second to T-12.", { proposal: IMAGE_PROPOSAL }),
]);

function SampleComposer({ initial = "", ...rest }: { initial?: string; running?: boolean; error?: string | null; runningElsewhere?: boolean; busy?: boolean; disabled?: boolean; images?: string[]; imageUrls?: Map<string, string>; uploading?: boolean; imageError?: string | null }) {
  const [value, setValue] = useState(initial);
  return <AgentChatComposer value={value} onChange={setValue} onSend={noop} onStop={noop} runOptions={RUN_OPTIONS} runValue={runSelectValue(DEFAULT_RUN)} onRunChange={noop}
    running={rest.running ?? false} busy={rest.busy ?? false} runningElsewhere={rest.runningElsewhere ?? false} error={rest.error ?? null} disabled={rest.disabled}
    images={rest.images} imageUrls={rest.imageUrls} uploading={rest.uploading} imageError={rest.imageError} onAttach={noop} onRemoveImage={noop} />;
}

function Panel({ state = "ready", conversation: shown = null, turn = null, pending = null, repositories = false, history = false, children }: {
  state?: AgentChatLogState;
  conversation?: AgentChatConversation | null;
  turn?: AgentChatTurn | null;
  pending?: string | null;
  repositories?: boolean;
  history?: boolean;
  children?: ReactNode;
}) {
  return <AgentChatPanelFrame isStatic>
    <AgentChatHeader historyOpen={history} onToggleHistory={noop} onNew={noop} onMinimize={noop} />
    {repositories && <AgentChatRepositoryRow options={REPOSITORIES} value={REPOSITORIES[0].value} onChange={noop} />}
    <div className="agentChatBody">
      {history
        ? <AgentChatHistory conversations={HISTORY} openId={HISTORY[0].id} runningId={null} onOpen={noop} onDelete={noop} />
        : <AgentChatMessages state={state} conversation={shown} turn={turn} pendingMessage={pending} imageUrls={IMAGE_URLS} tasks={TASKS} resolving={null} onSuggest={noop} onApply={noop} onDismiss={noop} />}
    </div>
    {children}
  </AgentChatPanelFrame>;
}

const START_SUMMARY = "Start a session for T-12.";
const start = (state: AgentChatProposal["state"], results?: AgentChatOperationResult[]): AgentChatProposal => ({ id: "p-0123456789ac", summary: START_SUMMARY, operations: [{ op: "start_session", id: "T-12" }], state, ...(results ? { results } : {}) });
const queue = (on: boolean, state: AgentChatProposal["state"], results?: AgentChatOperationResult[]): AgentChatProposal => ({ id: "p-0123456789ad", summary: on ? "Turn the queue on." : "Turn the queue off.", operations: [{ op: "set_queue", on }], state, ...(results ? { results } : {}) });
const HELD_LINE ="This task is held: Claude Code is above 85% of the five-hour window.";

function Card({ label, note, shown, busy = false, startHere = true, held = false }: { label: string; note?: string; shown: AgentChatProposal; busy?: boolean; startHere?: boolean; held?: boolean }) {
  return <Sample label={label} note={note}><div className="designSystemTaskFrame">
    <AgentChatProposalCard proposal={shown} tasks={TASKS} imageUrls={IMAGE_URLS} busy={busy} startHere={startHere} heldStart={held ? () => HELD_LINE : undefined} onApply={noop} onDismiss={noop} />
  </div></Sample>;
}

export function AgentChatSection() {
  return <Section id="agent-chat" title="Agent chat" lede="The Aril launcher and panel: shell chrome and the six button roles, drawn from invented conversations. The real panel is a floating region at the bottom right of the desktop app and of a paired phone, never on this page.">
    <div className="designSystemGrid">
      <Sample label="Launcher"><AgentChatLauncher isStatic answering={false} fresh={false} /></Sample>
      <Sample label="Launcher, answering" note="While an answer is being written and the panel is minimized."><AgentChatLauncher isStatic answering fresh={false} /></Sample>
      <Sample label="Launcher, new answer" note="A brand dot until the panel is opened; the accessible name adds “new answer”."><AgentChatLauncher isStatic answering={false} fresh /></Sample>
    </div>
    <div className="designSystemGrid designSystemChatGrid">
      <Sample label="Panel, empty" note="Suggestions only fill the message field; nothing is sent.">
        <Panel state="empty" repositories><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, proposal" note="A pending proposal under Aril's answer: one row for each operation, and Apply changes or Dismiss.">
        <Panel conversation={PROPOSED}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, answer being written" note="The partial answer, one fixed activity line, and Stop in place of Send.">
        <Panel conversation={conversation([ASK])} turn={STREAMING_TURN}><SampleComposer running /></Panel>
      </Sample>
      <Sample label="Panel, conversations" note="The saved conversations replace the message list; the open one is marked.">
        <Panel history><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, notes under an answer" note="A failed answer, a timed-out answer, and a proposal that could not be read.">
        <Panel conversation={NOTES}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, images" note="The owner's message shows its images under the text. A proposal row that names an image shows it too.">
        <Panel conversation={WITH_IMAGES}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, no repository" note="The composer is disabled until a repository is observed.">
        <AgentChatPanelFrame isStatic>
          <AgentChatHeader historyOpen={false} onToggleHistory={noop} onNew={noop} onMinimize={noop} disabled />
          <div className="agentChatBody"><div className="agentChatLogFrame"><div className="agentChatLog"><p className="agentChatLoading">No repositories observed yet.</p></div></div></div>
          <SampleComposer disabled />
        </AgentChatPanelFrame>
      </Sample>
    </div>
    <div className="designSystemGrid designSystemChatGrid">
      <Card label="Proposal, pending" note="Apply changes is the card's one Primary; Dismiss is Quiet." shown={proposal("pending", undefined, OPERATIONS.filter((operation) => operation.op !== "delete_task"))} />
      <Card label="Proposal, pending, with a delete" note="A delete is marked in the error color, and the line under the actions adds that it cannot be undone." shown={proposal("pending")} />
      <Card label="Proposal, applying" note="Both actions are disabled and the card is busy while the answer is in flight." shown={proposal("pending")} busy />
      <Card label="Proposal, applied" shown={APPLIED} />
      <Card label="Proposal, partly applied" note="Pomegr stops at the first operation that fails; the rest read Not run." shown={PARTIAL} />
      <Card label="Proposal, an operation not found" shown={NOT_FOUND} />
      <Card label="Proposal, every result word" note="Reference only: a real proposal stops at its first failure." shown={EVERY_WORD} />
      <Card label="Proposal, dismissed" shown={proposal("dismissed", undefined, OPERATIONS.slice(0, 3))} />
      <Card label="Session start, proposed" note="A start is its own card with one row. Start session is its Primary, and nothing has started." shown={start("pending")} />
      <Card label="Session start, held" note="The start did not happen: the fixed line, then the gates the board reads now. The card stays open to another try." shown={start("pending", [{ ok: false, error: "not_started", start: "gate_held" }])} held />
      <Card label="Session start, failed" shown={start("pending", [{ ok: false, error: "not_started", start: "plugin_missing" }])} />
      <Card label="Session start, launched" note="Only a launch the desktop confirmed settles the card." shown={start("applied", [{ ok: true, start: "started" }])} />
      <Card label="Session start, on a paired device" note="A phone cannot apply a start from the chat, so the card has no Primary." shown={start("pending")} startHere={false} />
      <Card label="Queue change, on, proposed" note="A queue change is its own card with one row. The line under the actions says that Pomegr may then start tasks by itself." shown={queue(true, "pending")} />
      <Card label="Queue change, off, proposed" shown={queue(false, "pending")} />
      <Card label="Queue change, on a paired device" note="A phone can apply a queue change, so the card keeps its Primary." shown={queue(true, "pending")} startHere={false} />
      <Card label="Queue change, turned on" shown={queue(true, "applied", [{ ok: true, queue: "on" }])} />
      <Card label="Queue change, turned on and held" note="The queue is on, and a stalled or blocked task holds it, so the result is muted." shown={queue(true, "applied", [{ ok: true, queue: "blocked" }])} />
      <Card label="Queue change, turned off" shown={queue(false, "applied", [{ ok: true, queue: "off" }])} />
      <Card label="Queue change, not changed" note="The queue was not changed. The card stays open to another try, which asks for the same state." shown={queue(true, "pending", [{ ok: false, error: "unavailable" }])} />
    </div>
    <div className="designSystemGrid designSystemChatGrid">
      <Card label="Proposal, images, pending" note="A task created with an image, and an image attached to T-12. The strip is labelled Images for this task." shown={IMAGE_PROPOSAL} />
      <Card label="Proposal, an image not attached" note="The task was created, and the attach stopped at its limit. The line is fixed, by error." shown={IMAGE_FAILED} />
    </div>
    <div className="designSystemGrid">
      <Sample label="Composer, images" note="Two attached images above the row. The second has not arrived yet, so it is an empty frame of the same size.">
        <div className="designSystemTaskFrame"><SampleComposer initial="Which one is wrong?" images={[IMAGE_ONE, IMAGE_TWO]} imageUrls={PENDING_URLS} /></div>
      </Sample>
      <Sample label="Composer, uploading image" note="Send is disabled while an image is on its way to the desktop app.">
        <div className="designSystemTaskFrame"><SampleComposer initial="Which one is wrong?" images={[IMAGE_ONE]} imageUrls={IMAGE_URLS} uploading /></div>
      </Sample>
      <Sample label="Composer, image error" note="One fixed line as an alert; the images already attached stay.">
        <div className="designSystemTaskFrame"><SampleComposer initial="Which one is wrong?" images={[IMAGE_ONE]} imageUrls={IMAGE_URLS} imageError="An image can be at most 5 MB." /></div>
      </Sample>
      <Sample label="Composer, error" note="One fixed line as an alert; the typed text stays.">
        <div className="designSystemTaskFrame"><SampleComposer initial="Which task should run first?" error="Aril is already answering. Wait for it to finish." /></div>
      </Sample>
      <Sample label="Composer, over the limit" note="The counter appears past 3,600 characters and turns to the error color past 4,000; Send is disabled.">
        <div className="designSystemTaskFrame"><SampleComposer initial={"x".repeat(4_012)} /></div>
      </Sample>
      <Sample label="Composer, answering elsewhere" note="Send is disabled while an answer is being written in another conversation.">
        <div className="designSystemTaskFrame"><SampleComposer initial="Is any task too big?" runningElsewhere /></div>
      </Sample>
    </div>
    <Wide label="Answer text" note="Paragraphs, lists, bold, inline code and fenced code. HTML, links and images stay literal text: nothing here can navigate.">
      <AgentChatMarkdown text={[ANSWER, "", "<img src=x onerror=alert(1)> [a link](javascript:alert(1))"].join("\n")} />
    </Wide>
  </Section>;
}
