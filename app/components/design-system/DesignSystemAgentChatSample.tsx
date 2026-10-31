"use client";

import { useState, type ReactNode } from "react";
import type { TaskEffort } from "../../../shared/task-contract";
import type { AgentChatAgentMessage, AgentChatBoardOperation, AgentChatChoices, AgentChatMessage, AgentChatOperationResult, AgentChatProposal, AgentChatSearchMatch, AgentChatThreadMessage, AgentChatThreadSummary, AgentChatTurn } from "../../../shared/agent-chat-contract";
import { AgentChatComposer } from "../agent-chat/AgentChatComposer";
import { AgentChatHeader, AgentChatLauncher, AgentChatPanelFrame, AgentChatScrim } from "../agent-chat/AgentChatFrame";
import { SafeMarkdown } from "../markdown/SafeMarkdown";
import { AgentChatMessages, type AgentChatLogState } from "../agent-chat/AgentChatMessages";
import { AgentChatProposalCard } from "../agent-chat/AgentChatProposalCard";
import { AgentChatSearch } from "../agent-chat/AgentChatSearch";
import { NO_MODELS } from "../tasks/task-fields";
import { chatModelOptions, chatModelValue, initialChatRun } from "../agent-chat/agent-chat-run";
import { Sample, Section } from "./DesignSystemKit";

// Static samples of the Aril chat: the real panel parts drawn from invented conversations. Nothing here reads a store.

const noop = () => undefined;
const AT = "2026-10-11T10:00:00.000Z";
const LATER = "2026-10-11T10:05:00.000Z";
const REPOSITORIES = [{ value: "repo-000000000000000000000001", label: "pomegr" }, { value: "repo-000000000000000000000002", label: "catalogus" }];
// The model list the chat reads: named models grouped by provider, and the run it starts on is never a default.
const SAMPLE_MODELS = { ...NO_MODELS, claude: ["model-large", "model-small"], codex: ["model-code"] };
const SAMPLE_RUN = initialChatRun(SAMPLE_MODELS, null);
const MODEL_OPTIONS = chatModelOptions(SAMPLE_MODELS, SAMPLE_RUN);
const BARE_RUN = initialChatRun(NO_MODELS, null);
const BARE_OPTIONS = chatModelOptions(NO_MODELS, BARE_RUN);
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

const agent = (id: string, text: string, overrides: Partial<AgentChatAgentMessage> = {}): AgentChatAgentMessage => ({ id, role: "agent", text, at: AT, provider: "claude", model: "model-large", effort: "medium", status: "complete", ...overrides });

// The thread of the sample repository: each message names the conversation it is saved in, and the panel draws them as one.
function thread(messages: AgentChatMessage[]): AgentChatThreadMessage[] {
  return messages.map((message) => ({ ...message, conversationId: "chat-0123456789ab" }));
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
const PROPOSED = thread([ASK, agent("m-2", ANSWER, { proposal: proposal("pending") })]);
// Aril's choices under an answer: quick replies, or one question whose first option is the one Aril recommends.
const REPLIES: AgentChatChoices = { replies: ["Squash", "Merge commit", "Tell me more"] };
const QUESTION: AgentChatChoices = {
  question: "Which merge method should this repository use?",
  options: [
    { label: "Squash", detail: "One commit for each pull request, as the history shows." },
    { label: "Merge commit", detail: "Keeps every commit; the history is busier." },
    { label: "Rebase", detail: "A straight history, but it rewrites commits." },
  ],
};
const FITS = "Squash fits: the history is one commit for each pull request.";
const REPLY_ASK = thread([{ id: "m-1", role: "user", text: "How should this repository merge?", at: AT }, agent("m-2", FITS, { choices: REPLIES })]);
const REPLY_ANSWERED = thread([...REPLY_ASK, { id: "m-3", role: "user", text: "Squash", at: LATER }, agent("m-4", "Squash it is. I will settle it once you apply the setting.", { at: LATER })]);
const QUESTION_ASK = thread([{ id: "m-1", role: "user", text: "How should this repository merge?", at: AT }, agent("m-2", "Three methods are allowed on GitHub, and they differ in the history they leave.", { choices: QUESTION })]);
const QUESTION_ANSWERED = thread([...QUESTION_ASK, { id: "m-3", role: "user", text: "Merge commit", at: LATER }, agent("m-4", "Merge commit it is.", { at: LATER })]);
const STREAMING_TURN: AgentChatTurn = { conversationId: "chat-0123456789ab", startedAt: AT, provider: "claude", model: "model-large", effort: "medium", activity: "reading_files", text: "I am reading the upload client and the board. The retry path is" };
const QUIET = thread([
  ASK,
  agent("m-2", "I cut it into three tasks. Apply them when you are ready.", { at: AT }),
  agent("m-3", "Merged T-5 and started T-6. Nothing needs you yet.", { grantFollowUp: true, at: LATER, effort: null }),
  agent("m-4", "Could not merge T-7. T-7 needs you.", { grantFollowUp: true, at: LATER, effort: null }),
]);
// A thread summarized for Aril up to its second message. The answer after the line was measured, so its time shows the preparation and the timing as a tooltip.
const SUMMARIZED: AgentChatThreadSummary = { through: { conversationId: "chat-0123456789ab", messageId: "m-2", at: AT }, at: LATER };
const SUMMARIZED_THREAD = thread([
  ASK,
  agent("m-2", "I cut it into three tasks. Apply them when you are ready.", { at: AT }),
  { id: "m-3", role: "user", text: "Apply the first two and keep the third for later.", at: LATER },
  agent("m-4", "Done. T-19 and T-20 are in Ready; the third stays in Backlog.", { at: LATER, timing: { eventMs: 1_200, textMs: 6_800, doneMs: 11_400, prompt: { instructions: 24_000, board: 18_000, taskLog: 300, conversation: 9_000, message: 52, other: 1_800 },
    prepare: { total: 3_200, board: 120, root: 90, github: 2_900, workflow: 480, worktrees: 640, environment: 1_100 } } }),
]);
const NOTES = thread([
  ASK,
  agent("m-2", "I started to answer, then the run ended.", { status: "failed" }),
  { id: "m-3", role: "user", text: "Try again.", at: AT },
  agent("m-4", "", { status: "timed_out" }),
  agent("m-5", "The proposal below could not be read.", { proposalUnreadable: true }),
]);

// Three invented matches of a search for "retry", newest first: a message of today's thread, and two of an earlier day.
const MATCHES: AgentChatSearchMatch[] = [
  { conversationId: "chat-000000000001", messageId: "m-2", at: AT, role: "agent", snippet: "The upload client has no retry, and the log cannot show one. I would cut this into three tasks…" },
  { conversationId: "chat-000000000001", messageId: "m-1", at: "2026-10-10T16:30:00.000Z", role: "user", snippet: "Add a retry to the upload client" },
  { conversationId: "chat-000000000002", messageId: "m-4", at: "2026-10-09T09:15:00.000Z", role: "agent", snippet: "…with backoff, so a retry never repeats the same request at once." },
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
const PLACE_OPERATIONS: AgentChatBoardOperation[] = [
  { op: "create_task", text: "Retry the upload after a token refresh", placeAfter: "T-12" },
  { op: "create_task", text: "Show upload progress per file", column: "Ready", position: 0 },
];
const PLACED = proposal("pending", undefined, PLACE_OPERATIONS);
const NOT_PLACED = proposal("partial", [{ ok: false, error: "not_found", taskId: "T-19", part: "placement" }, skipped], PLACE_OPERATIONS);
const WITH_IMAGES = thread([
  { id: "m-1", role: "user", text: "The upload dialog looks wrong in both of these. Can you make a task for the first one and add the second to T-12?", at: AT, images: [sentImage(IMAGE_ONE), sentImage(IMAGE_TWO)] },
  agent("m-2", "I would create one task with the first image and attach the second to T-12.", { proposal: IMAGE_PROPOSAL }),
]);

export function SampleComposer({ initial = "", ...rest }: { initial?: string; repositories?: boolean; noModels?: boolean; effort?: TaskEffort; running?: boolean; error?: string | null; busy?: boolean; disabled?: boolean; images?: string[]; imageUrls?: Map<string, string>; uploading?: boolean; imageError?: string | null }) {
  const [value, setValue] = useState(initial);
  return <AgentChatComposer value={value} onChange={setValue} onSend={noop} onStop={noop} modelOptions={rest.noModels ? BARE_OPTIONS : MODEL_OPTIONS} modelValue={chatModelValue(rest.noModels ? BARE_RUN : SAMPLE_RUN)} onModelChange={noop} effort={rest.effort ?? SAMPLE_RUN.effort} onEffortChange={noop}
    repositories={rest.repositories ? REPOSITORIES : undefined} repositoryId={REPOSITORIES[0].value} onRepositoryChange={noop}
    running={rest.running ?? false} busy={rest.busy ?? false} error={rest.error ?? null} disabled={rest.disabled}
    images={rest.images} imageUrls={rest.imageUrls} uploading={rest.uploading} imageError={rest.imageError} onAttach={noop} onRemoveImage={noop} />;
}

function Panel({ state = "ready", messages = [], summarized = null, turn = null, pending = null, search = null, loadingOlder = false, expanded = false, children }: {
  state?: AgentChatLogState;
  messages?: AgentChatThreadMessage[];
  summarized?: AgentChatThreadSummary | null;
  turn?: AgentChatTurn | null;
  pending?: string | null;
  /** The search under the header: what the field holds and what it found, or nothing when the search is closed. */
  search?: { query: string; matches: AgentChatSearchMatch[] | null } | null;
  loadingOlder?: boolean;
  expanded?: boolean;
  children?: ReactNode;
}) {
  return <AgentChatPanelFrame isStatic expanded={expanded}>
    <AgentChatHeader searchOpen={search !== null} onToggleSearch={noop} expanded={expanded} onToggleExpanded={noop} onClose={noop} />
    {search !== null && <AgentChatSearch query={search.query} onQueryChange={noop} matches={search.matches} failed={false} onChoose={noop} onClose={noop} />}
    <div className="agentChatBody">
      <AgentChatMessages state={state} messages={messages} summarized={summarized} turn={turn} pendingMessage={pending} pendingAt={pending === null ? null : AT} imageUrls={IMAGE_URLS} tasks={TASKS} resolving={null}
        hasOlder={loadingOlder} loadingOlder={loadingOlder} onSuggest={noop} onApply={noop} onDismiss={noop} />
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
  return <Section id="agent-chat" title="Agent chat" lede="The Aril launcher and panel: shell chrome and the six button roles, drawn from invented conversations. The real panel is docked to the right edge of the desktop app, or a full-screen sheet on a paired phone, and never on this page.">
    <div className="designSystemGrid">
      <Sample label="Launcher"><AgentChatLauncher isStatic answering={false} fresh={false} /></Sample>
      <Sample label="Launcher, answering" note="While an answer is being written and the panel is minimized."><AgentChatLauncher isStatic answering fresh={false} /></Sample>
      <Sample label="Launcher, new answer" note="A brand dot until the panel is opened; the accessible name adds “new answer”."><AgentChatLauncher isStatic answering={false} fresh /></Sample>
    </div>
    <div className="designSystemGrid designSystemChatGrid">
      <Sample label="Panel, empty" note="Suggestions only fill the message field; nothing is sent. The repository choice sits in the composer, and only when more than one repository is listed.">
        <Panel state="empty"><SampleComposer repositories /></Panel>
      </Sample>
      <Sample label="Panel, proposal" note="A pending proposal under Aril's answer: one row for each operation, and Apply changes or Dismiss. Each message shows its time.">
        <Panel messages={PROPOSED}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, quick replies" note="Small Quiet buttons under the newest answer. A tap sends the label as the owner's own message and does nothing else.">
        <Panel messages={REPLY_ASK}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, quick replies, answered" note="Once the owner sends anything after the answer, the replies are quiet text and the one that was picked is marked Chosen.">
        <Panel messages={REPLY_ANSWERED}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, quick replies, waiting" note="The newest answer's replies are disabled while a turn runs.">
        <Panel messages={REPLY_ASK} turn={STREAMING_TURN}><SampleComposer running /></Panel>
      </Sample>
      <Sample label="Panel, multiple-choice question" note="One row for each option: the label and a one-line detail, the recommended option first. The composer is the free answer.">
        <Panel messages={QUESTION_ASK}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, multiple-choice question, answered" note="The rows are quiet, and the row the owner picked is marked Chosen.">
        <Panel messages={QUESTION_ANSWERED}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, answer being written" note="The partial answer under a head with the time the turn started, one fixed activity line, and the round Stop in place of Send.">
        <Panel messages={thread([ASK])} turn={STREAMING_TURN}><SampleComposer running /></Panel>
      </Sample>
      <Sample label="Panel, activity lines" note="A grant follow-up is one quiet line: an icon, its text, and its time. It has no head and no card.">
        <Panel messages={QUIET}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, earlier messages summarized" note="Where Pomegr summarized the older messages for Aril, one quiet line shows an icon, fixed words, and the time. The messages stay readable and searchable. The time of a measured answer adds its timing to the tooltip.">
        <Panel messages={SUMMARIZED_THREAD} summarized={SUMMARIZED}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, search" note="The search opens under the header. Each match shows who wrote it, its time, and an excerpt with the searched text emphasized. Choosing one loads the thread to that message and marks it for a moment.">
        <Panel messages={PROPOSED} search={{ query: "retry", matches: MATCHES }}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, search without a match" note="One quiet line. Before anything is typed, the line reads what the search covers.">
        <Panel messages={PROPOSED} search={{ query: "rollback", matches: [] }}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, earlier messages loading" note="Scrolling to the first message loads the page before it. A quiet status shows at the top while it loads, and the log stays where the owner was reading.">
        <Panel messages={PROPOSED} loadingOlder><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, notes under an answer" note="A failed answer, a timed-out answer, and a proposal that could not be read.">
        <Panel messages={NOTES}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel, images" note="The owner's message shows its images under the text. A proposal row that names an image shows it too.">
        <Panel messages={WITH_IMAGES}><SampleComposer /></Panel>
      </Sample>
      <Sample label="Panel header, Aril On" note="The state sits beside the name as a chip: On in the positive tone. The panel exists only while Aril is On, and nothing is drawn until the desktop has answered. With Aril Off there is no panel, launcher, or expanded page to draw.">
        <AgentChatPanelFrame isStatic><AgentChatHeader searchOpen={false} onToggleSearch={noop} expanded={false} onToggleExpanded={noop} onClose={noop} arilOn /></AgentChatPanelFrame>
      </Sample>
      <Sample label="Panel, no repository" note="The composer is disabled until a repository is observed.">
        <AgentChatPanelFrame isStatic>
          <AgentChatHeader searchOpen={false} onToggleSearch={noop} expanded={false} onToggleExpanded={noop} onClose={noop} disabled />
          <div className="agentChatBody"><div className="agentChatLogFrame"><div className="agentChatLog"><p className="agentChatLoading">No repositories observed yet.</p></div></div></div>
          <SampleComposer disabled />
        </AgentChatPanelFrame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Panel, over the dimmed page" note="The panel lays over the page and does not move it. A light scrim dims the page below the header, behind the panel, and a click on it closes the panel. The scrim is not drawn at 760px and narrower, where the panel is a sheet.">
        <div className="designSystemChatStage">
          <div className="designSystemChatPage"><b>Tasks</b><span>Ready (3)</span><span>In progress (1)</span><span>Review (2)</span></div>
          <AgentChatScrim isStatic />
          <Panel messages={PROPOSED}><SampleComposer /></Panel>
        </div>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Panel, expanded" note="Expanded, the panel covers the content area beside the rail. The header keeps its place; the log and the composer sit in a centered column about 760px wide. The header action reads Dock and is pressed.">
        <Panel messages={PROPOSED} expanded><SampleComposer repositories /></Panel>
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
      <Card label="Queue change, on, proposed" note="A queue change is its own card with one row. The line under the actions says that Pomegr may then start tasks by itself. A phone can apply a queue change too, so the card keeps its Primary there." shown={queue(true, "pending")} />
      <Card label="Queue change, off, proposed" shown={queue(false, "pending")} />
      <Card label="Queue change, turned on" shown={queue(true, "applied", [{ ok: true, queue: "on" }])} />
      <Card label="Queue change, turned on and held" note="The queue is on, and a stalled or blocked task holds it, so the result is muted." shown={queue(true, "applied", [{ ok: true, queue: "blocked" }])} />
      <Card label="Queue change, turned off" shown={queue(false, "applied", [{ ok: true, queue: "off" }])} />
      <Card label="Queue change, not changed" note="The queue was not changed. The card stays open to another try, which asks for the same state." shown={queue(true, "pending", [{ ok: false, error: "unavailable" }])} />
    </div>
    <div className="designSystemGrid designSystemChatGrid">
      <Card label="Proposal, images, pending" note="A task created with an image, and an image attached to T-12. The strip is labelled Images for this task." shown={IMAGE_PROPOSAL} />
      <Card label="Proposal, an image not attached" note="The task was created, and the attach stopped at its limit. The line is fixed, by error." shown={IMAGE_FAILED} />
      <Card label="Proposal, new tasks placed" note="One task below T-12, in T-12's column, and one at the top of Ready. Placing a card never queues it." shown={PLACED} />
      <Card label="Proposal, a new task not placed" note="The task was created, and its placement named a task that is gone. The line names the new task." shown={NOT_PLACED} />
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
      <Sample label="Composer, repository" note="With more than one repository listed, the repository choice follows Attach. The buttons and select triggers have no frame, and Send is round.">
        <div className="designSystemTaskFrame"><SampleComposer initial="Which task should run first?" repositories /></div>
      </Sample>
      <Sample label="Composer, model and effort" note="The model and the effort follow the spacer. The model list holds named models only, grouped by provider, and never offers a default. The effort is Low, Medium, High, or Xhigh, and starts at Medium.">
        <div className="designSystemTaskFrame"><SampleComposer initial="Which model fits this?" effort="high" /></div>
      </Sample>
      <Sample label="Composer, no known model" note="Only when no model is known at all for a provider, the model reads the provider's name.">
        <div className="designSystemTaskFrame"><SampleComposer initial="Which task should run first?" noModels /></div>
      </Sample>
      <Sample label="Composer, error" note="One fixed line as an alert; the typed text stays.">
        <div className="designSystemTaskFrame"><SampleComposer initial="Which task should run first?" error="Aril is already answering. Wait for it to finish." /></div>
      </Sample>
      <Sample label="Composer, over the limit" note="The counter appears past 3,600 characters and turns to the error color past 4,000; Send is disabled.">
        <div className="designSystemTaskFrame"><SampleComposer initial={"x".repeat(4_012)} /></div>
      </Sample>
    </div>
    <Wide label="Answer text" note="Tables, quotes, rules, nested and task lists, emphasis, strikethrough, and code. HTML, links and images stay literal text: nothing here can navigate.">
      <SafeMarkdown text={[
        ANSWER, "",
        "| Proof | Result |",
        "|---|---|",
        "| `npm test` | Pass |",
        "| `npm run lint` | Pass |",
        "",
        "> Keep *one retry policy*; ~~duplicate retries~~ are removed.",
        "", "---", "",
        "- Client",
        "  - [x] Add retry",
        "  - [ ] Review limits",
        "", "<img src=x onerror=alert(1)> [a link](javascript:alert(1))",
      ].join("\n")} />
    </Wide>
  </Section>;
}
