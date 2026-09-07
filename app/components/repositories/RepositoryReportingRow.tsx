import type { RepositoryReportingSetup } from "../../../shared/repository-plugin-contract";
import { reportingState } from "./repository-setup-details";
import { RepositoryRow } from "./RepositoryRow";

export function RepositoryReportingRow({ reporting }: {
  reporting: RepositoryReportingSetup | undefined;
}) {
  const state = reportingState(reporting);
  return <section className="repositoryReportingSection" aria-label="Shared repository reporting">
    <RepositoryRow title="Repository reporting" label={state.label} tone={state.tone === "ready" ? "positive" : state.tone === "warning" ? "warning" : "neutral"} detail={state.detail} actions={null} />
    <div className="repositoryReportingHelp"><strong>Set up reporting in your coding agent</strong><p>Use <code>/pomegr:init</code> in Claude Code or <code>$pomegr:init</code> in Codex. The agent proposes repository signals for you to review before saving.</p><p><a className="commandTextLink" href="https://github.com/Lecarvalho/pomegr/blob/main/docs/PLUGINS.md">Read the plugin instructions</a></p></div>
  </section>;
}
