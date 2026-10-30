"use client";

import type { ProviderServiceStatus } from "../../../shared/monitor-contract";
import { ProviderStatusQuiet } from "../ProviderStatus";
import type { TaskLog } from "../tasks/task-desktop";
import { HomeArilLine } from "../home/HomeArilLine";
import { HomeChips, HomeComposerShell } from "../home/HomeAril";
import { HomeRunningList } from "../home/HomeContinue";
import { HomeNeedsYou } from "../home/HomeNeedsYou";
import { HomeUpdateCard } from "../home/HomeUpdateCard";
import { HomeUpdateIllustration } from "../home/HomeUpdateIllustration";
import { arilLine, type HomeLogReads, type NeedsLine, type RunningSession } from "../home/home-model";
import { homeSuggestions } from "../agent-chat/agent-chat-presentation";
import { SampleComposer } from "./DesignSystemAgentChatSample";
import { SAMPLE_TIME, Sample, Section } from "./DesignSystemKit";

const HIGHLIGHTS = ["A highlight is one short sentence.", "Two or three are enough."];
const ignore = () => undefined;

export function HomeUpdateSection() {
  return <Section id="home-update" title="Home update" lede="Home's What's new line (HomeUpdateCard) is one quiet action that names the announcement, and an icon dismiss, in the status line at the foot of Home. The action opens a modal dialog with the illustration at full size, the description, short highlights, and the primary Got it, which closes the dialog and keeps the line. Only the line's icon dismiss dismisses the announcement.">
    <div className="designSystemStates">
      <Sample label="With illustration" note="The illustration is decorative static artwork authored 408px wide, shown only in the dialog. The dialog is a centered 560px panel on desktop and a bottom sheet at 760px and narrower. Dismiss is inert here.">
        <HomeUpdateCard title="Announcement title" description="A sentence or two naming the main benefit in the interface's own terms." highlights={HIGHLIGHTS} illustration={<HomeUpdateIllustration />} onDismiss={ignore} />
      </Sample>
      <Sample label="Text only" note="Without an illustration the dialog drops the artwork and keeps the same copy and actions.">
        <HomeUpdateCard title="Announcement title" description="A sentence or two naming the main benefit in the interface's own terms." highlights={HIGHLIGHTS} onDismiss={ignore} />
      </Sample>
    </div>
  </Section>;
}

// One line for each thing the owner has to do. No task ID and no title: the action, a failure detail in amber, and the repository.
const NEEDS: NeedsLine[] = [
  { key: "s", action: "Answer a session that is waiting for you", detail: null, repository: "clapline", href: "/sessions" },
  { key: "r1", action: "Review 5 finished tasks", detail: null, repository: "clapline", href: "/tasks" },
  { key: "r2", action: "Review 1 finished task", detail: { words: "CI failed", urgent: true }, repository: "pomegr", href: "/tasks" },
  { key: "t", action: "Check 2 stalled tasks", detail: null, repository: "pomegr", href: "/tasks" },
  { key: "q", action: "Restart the paused queue", detail: { words: "CLI not found", urgent: true }, repository: "waymark", href: "/tasks" },
];

const RUNNING: RunningSession[] = [
  { key: "a", title: "Storage allowance pricing decision", waiting: true, meta: "clapline · Codex · 2 min", href: "/sessions" },
  { key: "b", title: "Rough overlay and animatic player polish", waiting: false, meta: "clapline · Claude Code · 12 min", href: "/sessions" },
  { key: "c", title: "Build the new Home", waiting: false, meta: "pomegr · Claude Code · 4 min", href: "/sessions" },
];

const provider = (id: "claude" | "codex", source: string, status: ProviderServiceStatus["status"]): ProviderServiceStatus => ({
  provider: id, source: source as ProviderServiceStatus["source"], statusPageUrl: id === "claude" ? "https://status.claude.com" : "https://status.openai.com", status, readiness: "ready", freshness: "fresh",
  checkedAt: new Date(SAMPLE_TIME).toISOString(), updatedAt: new Date(SAMPLE_TIME).toISOString(), incidentKey: null, incidents: [],
});

const entry = (id: number, task: string, kind: TaskLog["entries"][number]["kind"], hoursAgo: number): TaskLog["entries"][number] => ({ id, task, kind, at: SAMPLE_TIME - hoursAgo * 3_600_000, pullRequest: null });
const LOG: TaskLog = {
  entries: [entry(1, "T-41", "started", 20), entry(2, "T-41", "review", 6), entry(3, "T-38", "started", 9), entry(4, "T-38", "review", 5), entry(5, "T-38", "merged", 2), entry(6, "T-30", "done", 1), entry(7, "T-20", "done", 30)],
  more: false, arilCursor: 0,
};
const QUIET_LOG: TaskLog = { entries: [entry(1, "T-20", "done", 30)], more: false, arilCursor: 0 };
const reads = (...logs: (TaskLog | null)[]): HomeLogReads => new Map(logs.map((log, index) => [`repo-${String(index).repeat(24)}`, log]));

export function HomeSection() {
  return <Section id="home" title="Home" lede="Home is one centered column: a greeting, the Aril line, Needs you, Continue, a status line, and the composer with its suggestions. Fixed rules write the Aril line and pick the Needs you lines from the boards, the task logs, and the sessions Pomegr observes; no model runs. The composer is the chat composer, and the suggestion chips fill its field without sending. Focusing the composer lifts it to the middle of the page, and Send hands the page to the maximized Aril view.">
    <div className="designSystemStates">
      <Sample label="Aril line, with counts" note="The tasks the logs of the last 24 hours record, once for each event, in a fixed order. Sample times are illustrative.">
        <div className="designSystemTaskFrame"><HomeArilLine>{arilLine(reads(LOG), SAMPLE_TIME)}</HomeArilLine></div>
      </Sample>
      <Sample label="Aril line, nothing logged" note="Logs were read and hold no event in the window.">
        <div className="designSystemTaskFrame"><HomeArilLine>{arilLine(reads(QUIET_LOG), SAMPLE_TIME)}</HomeArilLine></div>
      </Sample>
      <Sample label="Aril line, a log could not be read" note="The line says so. When no log could be read, the line is not drawn, and it never says that nothing happened.">
        <div className="designSystemTaskFrame"><HomeArilLine>{arilLine(reads(LOG, null), SAMPLE_TIME)}</HomeArilLine></div>
      </Sample>
      <Sample label="Aril line, reading" note="Quiet words until the first read of the logs ends.">
        <div className="designSystemTaskFrame"><HomeArilLine status>Reading the task logs…</HomeArilLine></div>
      </Sample>
    </div>
    <div className="designSystemGrid designSystemChatGrid">
      <Sample label="Needs you" note="One line for each thing to do, grouped by kind and repository, with the repository on the right. No task ID and no title. Amber text only for a failure: CI failed, Review failed, Merge refused, and the reason a queue is paused. Sessions that wait come first, then finished tasks, stalled tasks, blocked tasks, and paused queues.">
        <div className="designSystemTaskFrame"><HomeNeedsYou lines={NEEDS} total={NEEDS.length} /></div>
      </Sample>
      <Sample label="Continue, running sessions" note="Up to four live sessions that work or wait for the owner. A state dot, the title (the task's title for a session started for a task), the state, and the repository, provider, and time since the session started. A session that waits shows Waiting for you in amber.">
        <div className="designSystemTaskFrame"><HomeRunningList sessions={RUNNING} /></div>
      </Sample>
      <Sample label="Provider status, healthy" note="A muted dot and the provider's name. The popover keeps the details.">
        <div className="designSystemTaskFrame"><ProviderStatusQuiet providers={[provider("claude", "Claude Code", "operational"), provider("codex", "Codex", "operational")]} /></div>
      </Sample>
      <Sample label="Provider status, not healthy" note="Only a provider that reports a degraded service, a maintenance, or an outage gets words, in amber.">
        <div className="designSystemTaskFrame"><ProviderStatusQuiet providers={[provider("claude", "Claude Code", "operational"), provider("codex", "Codex", "degraded")]} /></div>
      </Sample>
      <Sample label="Composer on Home, with suggestions" note="The chips are the Quiet role on the raised fill with the composer radius. A chip fills the message field and sends nothing.">
        <div className="designSystemTaskFrame agentChatHome">
          <HomeChips suggestions={homeSuggestions({ attention: true, work: true })} onPick={ignore} />
          <SampleComposer repositories />
        </div>
      </Sample>
      <Sample label="Composer on Home, focus mode" note="Focusing the composer, or picking a chip, fades the rest of Home out and lifts the composer, with the chips above it and the hint under it, to the middle of the content area. The composer takes the overlay shadow while it is lifted. Esc, or a click outside while the field is empty, returns to Home; Send turns the page into the maximized Aril view.">
        <div className="designSystemTaskFrame">
          <HomeComposerShell mode="focus">
            <HomeChips suggestions={homeSuggestions({ attention: true, work: true })} onPick={ignore} />
            <SampleComposer initial="What needs my attention first?" repositories />
          </HomeComposerShell>
        </div>
      </Sample>
    </div>
  </Section>;
}
