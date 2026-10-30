import type { ContextInventoryRevisionSummary, RepositoryProviderInventory, RepositorySummary } from "../../../shared/monitor-contract";
import { ProviderBadge } from "../ProviderBadge";
import { ContextAllocationBreakdown } from "../context-inventory/ContextAllocationBreakdown";
import { InventoryCaptureAction, InventoryCaptureConfirmation } from "../repositories/InventoryCapture";
import { PluginSetupRow } from "../repositories/PluginSetupRow";
import { RepositoryRow } from "../repositories/RepositoryRow";
import { inventoryState, type ProviderFeedback } from "../repositories/repository-setup-details";
import { Sample, Section } from "./DesignSystemKit";

const REVISION: ContextInventoryRevisionSummary = {
  id: "r1", capturedAt: "2026-10-25T12:00:00.000Z", model: "sample-model", machineryTokens: 12_000,
  contextAllocation: null, categoryCount: 3, itemCount: 6, change: { state: "first_capture", previousRevisionId: null },
};
const PROVIDER: RepositoryProviderInventory = {
  provider: "claude", source: "Claude Code", sessionCount: 1, supported: true,
  status: "not_captured", failureKind: null, currentRevision: null, revisions: [],
  pluginSetup: {
    readiness: "ready", installation: "installed", version: "1.0.0", enabled: true, scope: "project", checkedAt: null,
    update: { status: "current", version: "1.0.0", checkedAt: null }, canInstall: false, canUpdate: false,
  },
};
const UPDATE_PROVIDER: RepositoryProviderInventory = {
  ...PROVIDER, pluginSetup: { ...PROVIDER.pluginSetup!, update: { status: "available", version: "1.1.0", checkedAt: null }, canUpdate: true },
};
const REPOSITORY: RepositorySummary = {
  id: "sample-repository", name: "pomegr", displayName: "Pomegr", sessionCount: 1, liveCount: 0,
  historyCount: 1, providerCount: 1, updatedAt: null, providers: [PROVIDER],
};
const FEEDBACK: ProviderFeedback[] = [
  { key: "pending", tone: "pending", message: "Checking plugin setup." },
  { key: "success", tone: "success", message: "Plugin setup checked." },
  { key: "neutral", tone: "neutral", message: "No plugin changes were made." },
  { key: "error", tone: "error", message: "The plugin action could not finish. Recheck the local setup before trying again." },
];
const CAPTURES: { label: string; provider: RepositoryProviderInventory; detail: string }[] = [
  { label: "Current", provider: { ...PROVIDER, status: "current", currentRevision: REVISION, revisions: [REVISION] }, detail: "Captured 25 Oct 2026, 12:00 UTC" },
  { label: "Unavailable", provider: { ...PROVIDER, provider: "codex", source: "Codex", supported: false, status: "unavailable", pluginSetup: undefined }, detail: "Context inventory is not available for Codex yet." },
  { label: "Not captured", provider: PROVIDER, detail: "Native provider diagnostic" },
  { label: "Capturing", provider: { ...PROVIDER, status: "capturing" }, detail: "Previous revision remains available until commit" },
  { label: "Failed", provider: { ...PROVIDER, status: "failed", failureKind: "timed_out" }, detail: "The diagnostic timed out · no data saved" },
];

export function RepositorySetupSection() {
  return <Section id="repository-row" title="Repository setup row states" lede="The shipped setup row, plugin actions, and capture confirmation use illustrative data and fixed display strings. Sample actions do nothing.">
    <div className="designSystemRows">
      <Sample label="Up to date"><div className="designSystemRepositoryFrame">
        <PluginSetupRow provider={PROVIDER} desktop actionRunning={false} feedback={null} onAction={() => undefined} />
      </div></Sample>
      <Sample label="Update available"><div className="designSystemRepositoryFrame">
        <PluginSetupRow provider={UPDATE_PROVIDER} desktop actionRunning={false} feedback={null} onAction={() => undefined} />
      </div></Sample>
      {FEEDBACK.map((feedback) => <Sample key={feedback.key} label={`Feedback · ${feedback.tone}`}><div className="designSystemRepositoryFrame">
        <PluginSetupRow provider={PROVIDER} desktop actionRunning={feedback.tone === "pending"} feedback={feedback} onAction={() => undefined} />
      </div></Sample>)}
      {CAPTURES.map(({ label, provider, detail }) => <Sample key={label} label={label}><div className="designSystemRepositoryFrame">
        <RepositoryRow title="Context inventory" {...inventoryState(provider)} detail={detail}
          actions={<InventoryCaptureAction provider={provider} desktop busy={false} onConfirm={() => undefined} />} />
      </div></Sample>)}
      <Sample label="Provider section head"><div className="repositoryInventoryProvider designSystemRepositoryFrame">
        <header className="repositorySectionHead"><div><ProviderBadge source="Claude Code" /></div><span className="repositoryChecked">Captured 25 Oct 2026, 12:00 UTC</span></header>
      </div></Sample>
      <Sample label="Capture confirmation"><div className="repositoryDetail designSystemRepositoryFrame">
        <InventoryCaptureConfirmation repository={REPOSITORY} provider={PROVIDER} busy={false} onCancel={() => undefined} onCapture={() => undefined} />
      </div></Sample>
    </div>
  </Section>;
}

const CATEGORIES = [
  { name: "System instructions", tokens: "12k", percentage: 60, kind: "initial" as const },
  { name: "Tool definitions", tokens: "6k", percentage: 30, kind: "deferred" as const },
  { name: "Compaction headroom", tokens: "2k", percentage: 10, kind: "reserved" as const },
];

export function RevisionEvidenceSection() {
  return <Section id="revision-evidence" title="Revision evidence" lede="Repository facts, summary cards, and category evidence use shared classes with fixed illustrative strings. The allocation breakdown renders the shipped component from synthetic props.">
    <div className="designSystemRows">
      <Sample label="Repository facts"><div className="designSystemRepositoryFrame">
        <dl className="repositoryOverviewFacts" aria-label="Sample repository facts">
          <div><dt>Live sessions</dt><dd className="live">2</dd></div><div><dt>History</dt><dd>12</dd></div>
          <div><dt>Last activity</dt><dd>25 Oct 2026, 12:00 UTC</dd></div><div><dt>Providers</dt><dd className="repositoryOverviewProviders"><ProviderBadge source="Claude Code" /></dd></div>
        </dl>
      </div></Sample>
      <Sample label="Setup summaries"><div className="repositoryOverviewCards designSystemRepositoryFrame">
        {[{ title: "Pomegr plugin", label: "Installed", detail: "Illustrative plugin version 1.0.0" }, { title: "Reporting policy", label: "Configured", detail: "Shared repository policy" }, { title: "Context inventory", label: "Current", detail: "12k estimated initial tokens" }].map((card) => <div className="repositoryOverviewCard" key={card.title}>
          <h4>{card.title}</h4><span className="commandChip positive">{card.label}</span><p>{card.detail}</p><button type="button" className="commandTextLink">Open {card.title.toLowerCase()}</button>
        </div>)}
      </div></Sample>
      <Sample label="Saved revision summary"><section className="repositoryInventorySummary designSystemRepositoryFrame" aria-label="Sample inventory summary">
        <div><span>Captured</span><strong>25 Oct 2026, 12:00 UTC</strong></div><div><span>Model</span><strong>sample-model</strong></div>
        <div><span>Revision</span><strong>r1</strong></div><div className="repositoryInventoryInitial"><span>Estimated initial context</span><strong className="repositoryInventoryTokens">12k tokens</strong></div>
      </section></Sample>
      <Sample label="Context allocation"><div className="designSystemRepositoryFrame">
        <ContextAllocationBreakdown allocation={{ initialTokens: 12_000, deferredTokens: 6_000, reservedTokens: 2_000 }} categoryTotal={20_000} categories={CATEGORIES} />
      </div></Sample>
    </div>
  </Section>;
}
