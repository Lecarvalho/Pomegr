"use client";

import type { TaskLog } from "../tasks/task-desktop";
import { HomeDayMark, HomeDayReading, HomeDayTiles } from "../home/HomeDayTiles";
import { HomeChips, HomeComposerShell } from "../home/HomeAril";
import { HomeRunningList } from "../home/HomeContinue";
import { HomeNeedsYou } from "../home/HomeNeedsYou";
import { HomeUpdateCard } from "../home/HomeUpdateCard";
import { HomeUpdateIllustration } from "../home/HomeUpdateIllustration";
import { dayCounts, type HomeLogReads, type NeedsLine, type RunningSession } from "../home/home-model";
import { homeSuggestions } from "../agent-chat/agent-chat-presentation";
import { SampleComposer } from "./DesignSystemAgentChatSample";
import { SAMPLE_TIME, Sample, Section } from "./DesignSystemKit";

const HIGHLIGHTS = ["A highlight is one short sentence.", "Two or three are enough."];
const ignore = () => undefined;

export function HomeUpdateSection() {
  return <Section id="home-update" title="Home update" lede="Home's What's new card (HomeUpdateCard) is a horizontal teaser at the foot of Home, above the composer: a thumbnail of the announcement illustration at a small fixed size on the left, then a brand eyebrow, a title, and one summary line, a secondary See what's new action, and an icon dismiss. On a phone the card is one compact row: a smaller thumbnail, the eyebrow and the title, and a chevron; the whole row opens the dialog, and the dismiss keeps its 44px target. The action opens a modal dialog with the illustration at full size, the description, short highlights, and the primary Got it, which closes the dialog and keeps the card. Only the card's icon dismiss dismisses the announcement.">
    <div className="designSystemStates">
      <Sample label="With illustration" note="The illustration is decorative static artwork authored 408px wide; the card scales the same node down. The dialog is a centered 560px panel on desktop and a bottom sheet at 760px and narrower. Dismiss is inert here.">
        <HomeUpdateCard title="Announcement title" summary="One short line for the Home card." description="A sentence or two naming the main benefit in the interface's own terms." highlights={HIGHLIGHTS} illustration={<HomeUpdateIllustration />} onDismiss={ignore} />
      </Sample>
      <Sample label="Text only" note="Without an illustration the card and the dialog drop the artwork and keep the same copy and actions.">
        <HomeUpdateCard title="Announcement title" summary="One short line for the Home card." description="A sentence or two naming the main benefit in the interface's own terms." highlights={HIGHLIGHTS} onDismiss={ignore} />
      </Sample>
    </div>
  </Section>;
}

// One line for each thing the owner has to do. No task ID and no title: the action, a failure detail in amber, and the repository.
const NEEDS: NeedsLine[] = [
  { key: "s", kind: "session", action: "Answer a session that is waiting for you", detail: null, repository: "clapline", href: "/sessions" },
  { key: "r1", kind: "review", action: "Review 5 finished tasks", detail: null, repository: "clapline", href: "/tasks" },
  { key: "r2", kind: "review", action: "Review 1 finished task", detail: { words: "CI failed", urgent: true }, repository: "pomegr", href: "/tasks" },
  { key: "t", kind: "stalled", action: "Check 2 stalled tasks", detail: null, repository: "pomegr", href: "/tasks" },
  { key: "q", kind: "queue", action: "Restart the paused queue", detail: { words: "CLI not found", urgent: true }, repository: "waymark", href: "/tasks" },
];

const RUNNING: RunningSession[] = [
  { key: "a", title: "Storage allowance pricing decision", waiting: true, meta: "clapline · Codex · 2 min", href: "/sessions" },
  { key: "b", title: "Rough overlay and animatic player polish", waiting: false, meta: "clapline · Claude Code · 12 min", href: "/sessions" },
  { key: "c", title: "Build the new Home", waiting: false, meta: "pomegr · Claude Code · 4 min", href: "/sessions" },
];

const entry = (id: number, task: string, kind: TaskLog["entries"][number]["kind"], hoursAgo: number): TaskLog["entries"][number] => ({ id, task, kind, at: SAMPLE_TIME - hoursAgo * 3_600_000, pullRequest: null });
const LOG: TaskLog = {
  entries: [entry(1, "T-41", "started", 20), entry(2, "T-41", "review", 6), entry(3, "T-38", "started", 9), entry(4, "T-38", "review", 5), entry(5, "T-38", "merged", 2), entry(6, "T-30", "done", 1), entry(7, "T-20", "done", 30)],
  more: false, arilCursor: 0,
};
const QUIET_LOG: TaskLog = { entries: [entry(1, "T-20", "done", 30)], more: false, arilCursor: 0 };
const reads = (...logs: (TaskLog | null)[]): HomeLogReads => new Map(logs.map((log, index) => [`repo-${String(index).repeat(24)}`, log]));
const day = (logs: HomeLogReads) => dayCounts(logs, SAMPLE_TIME) ?? { counts: [0, 0, 0, 0], unreadable: 0 };

export function HomeSection() {
  return <Section id="home" title="Home" lede="Home is one centered column: a date and a greeting, the last 24 hours in four tiles, Needs you and Continue as two cards side by side (stacked on a phone), the What's new card, and the composer with its suggestions. Fixed rules count the tiles and pick the Needs you lines from the boards, the task logs, and the sessions Pomegr observes; no model runs. The composer is the chat composer, and the suggestion chips fill its field without sending. Focusing the composer lifts it to the middle of the page, and Send hands the page to the maximized Aril view.">
    <div className="designSystemStates">
      <Sample label="Last 24 hours, with counts" note="Four tiles: the tasks the logs of the last 24 hours record, once for each event, in a fixed order. Marked Done is green when it counts. Sample times are illustrative. A phone draws one row with the short labels.">
        <div className="designSystemTaskFrame"><HomeDayMark /><HomeDayTiles counts={day(reads(LOG)).counts} /></div>
      </Sample>
      <Sample label="Last 24 hours, nothing logged" note="Logs were read and hold no event in the window: the tiles stay and read zero, in quiet ink.">
        <div className="designSystemTaskFrame"><HomeDayTiles counts={day(reads(QUIET_LOG)).counts} /></div>
      </Sample>
      <Sample label="Last 24 hours, a log could not be read" note="The tiles count the logs that were read, and a quiet line says so. When no log could be read, the tiles are not drawn, and they never say that nothing happened.">
        <div className="designSystemTaskFrame"><HomeDayTiles counts={day(reads(LOG, null)).counts} unreadable={1} /></div>
      </Sample>
      <Sample label="Last 24 hours, reading" note="Quiet words until the first read of the logs ends.">
        <div className="designSystemTaskFrame"><HomeDayReading /></div>
      </Sample>
    </div>
    <div className="designSystemGrid designSystemChatGrid">
      <Sample label="Needs you" note="A card with the count of what waits as a badge. One rounded item for each thing to do, grouped by kind and repository, with a glyph, the action, and the repository under it; no rule between items, a hover fill, and a closing line. No task ID and no title. Amber text only for a failure: CI failed, Review failed, Merge refused, and the reason a queue is paused. Sessions that wait come first, then finished tasks, stalled tasks, blocked tasks, and paused queues.">
        <div className="designSystemTaskFrame"><HomeNeedsYou lines={NEEDS} total={NEEDS.length} /></div>
      </Sample>
      <Sample label="Continue, running sessions" note="Up to four live sessions that work or wait for the owner. A dot that pulses green while the session works, the title in two lines at most (the task's title for a session started for a task), the state, and the repository and time since the session last changed. Working is green, and a session that waits shows Waiting for you in amber with an amber dot.">
        <div className="designSystemTaskFrame"><HomeRunningList sessions={RUNNING} /></div>
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
