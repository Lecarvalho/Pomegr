import { useRef, useState } from "react";
import type { RepositoryReportingSetup } from "../../../shared/repository-plugin-contract";
import { reportingState } from "./repository-setup-details";
import { RepositoryRow } from "./RepositoryRow";

export function RepositoryReportingRow({ repositoryId, reporting, context = "setup" }: {
  repositoryId: string;
  reporting: RepositoryReportingSetup | undefined;
  context?: "setup" | "reporting";
}) {
  const [open, setOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const state = reportingState(reporting);
  const helpId = `repository-reporting-help-${repositoryId}-${context}`;
  return <section className="repositoryReportingSection" aria-label="Shared repository reporting">
    <RepositoryRow title="Repository reporting" label={state.label} tone={state.tone === "ready" ? "positive" : state.tone === "warning" ? "warning" : "neutral"} detail={state.detail} actions={<>
      {context === "setup" && <button type="button" className="commandTextLink" aria-expanded={open} aria-controls={helpId} onClick={() => setOpen((current) => !current)}>How reporting works</button>}
      <button type="button" className="commandSecondaryAction" aria-expanded={context === "setup" ? open : undefined} aria-controls={helpId} onClick={() => context === "reporting" ? helpRef.current?.focus() : setOpen((current) => !current)}>{reporting?.status === "configured" ? "Review policy" : "Configure reporting"}</button>
    </>} />
    {(open || context === "reporting") && <div className="repositoryReportingHelp" id={helpId} ref={helpRef} tabIndex={-1}><strong>Set up reporting in your coding agent</strong><p>Use <code>/pomegr:init</code> in Claude Code or <code>$pomegr:init</code> in Codex. The agent proposes repository signals for you to review before saving.</p><p><a className="commandTextLink" href="https://github.com/Lecarvalho/pomegr/blob/main/docs/PLUGINS.md">Read the plugin instructions</a></p></div>}
  </section>;
}
