import type { ContextInventoryRevisionSummary, RepositoryProviderInventory, RepositorySummary } from "../../../shared/monitor-contract";
import { ProviderBadge } from "../ProviderBadge";
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
