"use client";

import type { TaskLog } from "../tasks/task-desktop";
import { HomeArilLine } from "../home/HomeArilLine";
import { HomeChips } from "../home/HomeAril";
import { HomeNeedsYou } from "../home/HomeNeedsYou";
import { HomeUpdateCard } from "../home/HomeUpdateCard";
import { HomeUpdateIllustration } from "../home/HomeUpdateIllustration";
import { arilLine, type HomeLogReads, type NeedsItem } from "../home/home-model";
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

const REPOSITORY = `repo-${"a".repeat(24)}`;
const OTHER = `repo-${"b".repeat(24)}`;
const NEEDS: NeedsItem[] = [
  { kind: "queue", key: "queue", repositoryId: OTHER, repositoryName: "clapline", reason: "A start failed" },
  { kind: "task", key: "t1", repositoryId: REPOSITORY, repositoryName: "pomegr", taskId: "T-41", title: "Retry the upload with backoff", state: "needs_review", detail: { words: "CI failed", urgent: true } },
  { kind: "task", key: "t2", repositoryId: REPOSITORY, repositoryName: "pomegr", taskId: "T-38", title: "Show the retry count in the upload log", state: "needs_review", detail: { words: "Review passed", urgent: false } },
  { kind: "task", key: "t3", repositoryId: OTHER, repositoryName: "clapline", taskId: "T-12", title: "Move the settings page to the new shell", state: "needs_review", detail: null },
  { kind: "task", key: "t4", repositoryId: REPOSITORY, repositoryName: "pomegr", taskId: "T-35", title: "Cut the upload work into tasks", state: "stalled", detail: null },
  { kind: "task", key: "t5", repositoryId: OTHER, repositoryName: "clapline", taskId: "T-9", title: "Rename the export action", state: "blocked", detail: null },
];

const entry = (id: number, task: string, kind: TaskLog["entries"][number]["kind"], hoursAgo: number): TaskLog["entries"][number] => ({ id, task, kind, at: SAMPLE_TIME - hoursAgo * 3_600_000, pullRequest: null });
const LOG: TaskLog = {
  entries: [entry(1, "T-41", "started", 20), entry(2, "T-41", "review", 6), entry(3, "T-38", "started", 9), entry(4, "T-38", "review", 5), entry(5, "T-38", "merged", 2), entry(6, "T-30", "done", 1), entry(7, "T-20", "done", 30)],
  more: false, arilCursor: 0,
};
const QUIET_LOG: TaskLog = { entries: [entry(1, "T-20", "done", 30)], more: false, arilCursor: 0 };
const reads = (...logs: (TaskLog | null)[]): HomeLogReads => new Map(logs.map((log, index) => [`repo-${String(index).repeat(24)}`, log]));

export function HomeSection() {
  return <Section id="home" title="Home" lede="Home is one centered column: a greeting, the Aril line, Needs you, Continue, a status line, and the composer with its suggestions. Fixed rules write the Aril line and pick the Needs you rows from the task log and the boards; no model runs. The composer is the chat composer, and the suggestion chips fill its field without sending.">
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
      <Sample label="Needs you" note="A paused queue first, then the tasks that need review, are stalled, or are blocked. A Needs review task adds the newest CI, review, or merge result after it reported complete; failures take the amber text color. At most five rows, and a quiet link to the rest.">
        <div className="designSystemTaskFrame"><HomeNeedsYou items={NEEDS.slice(0, 5)} total={8} /></div>
      </Sample>
      <Sample label="Composer on Home, with suggestions" note="The chips are the Quiet role on the raised fill with the composer radius. A chip fills the message field and sends nothing. Open conversation opens the panel without sending.">
        <div className="designSystemTaskFrame agentChatHome">
          <HomeChips suggestions={homeSuggestions({ attention: true, work: true })} onPick={ignore} onOpen={ignore} />
          <SampleComposer repositories />
        </div>
      </Sample>
    </div>
  </Section>;
}
