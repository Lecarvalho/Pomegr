"use client";

import { SessionTerminalSurface, type HistoryPage } from "../dashboard/session-terminal/SessionTerminalPanel";
import { Sample, Section } from "./DesignSystemKit";

const history: HistoryPage = {
  status: "ok", reset: false, cursor: null, older: null,
  messages: [
    { kind: "owner", at: null, text: "Keep the last good session state visible while a refresh is incomplete." },
    { kind: "agent", at: null, text: "I will check when the cached revision is replaced and add a regression test." },
    { kind: "tool", at: null, name: "Read", outcome: "completed" },
    { kind: "tool", at: null, name: "Edit", outcome: "failed" },
    { kind: "tool", at: null, name: "Test", outcome: "pending" },
    { kind: "agent", at: null, text: "The previous revision stays visible until its replacement commits." },
  ],
};
const ignore = () => {};
const samples: { label: string; page: HistoryPage | null; live?: boolean; failed?: boolean; busy?: boolean }[] = [
  { label: "History", page: { ...history, older: { fingerprint: "synthetic", offset: 100 } } },
  { label: "Live with Refresh", page: history, live: true },
  { label: "Ended", page: history },
  { label: "Empty", page: { ...history, messages: [] } },
  { label: "Unavailable", page: { ...history, messages: [], status: "missing" } },
  { label: "Failed", page: null, failed: true },
  { label: "Reading", page: null, busy: true },
];

export function SessionTerminalSection() {
  return <Section id="session-terminal" title="Session Terminal" lede="Desktop-only saved history, read-only. These synthetic samples use the real terminal surface and read no session data.">
    <div className="designSystemGrid">{samples.map(({ label, page, live = false, failed = false, busy = false }) => <Sample key={label} label={label} note="Synthetic messages; sample controls do not read history.">
      <SessionTerminalSurface page={page} live={live} failed={failed} busy={busy} onRefresh={ignore} onEarlier={ignore} />
    </Sample>)}</div>
  </Section>;
}
