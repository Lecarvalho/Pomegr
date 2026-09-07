import type { RepositoryProviderInventory, RepositorySummary } from "../../../shared/monitor-contract";
import { compactNumber } from "../../dashboard-utils";
import { failureMessage, type ProviderFeedback } from "./repository-setup-details";
import { RepositoryRow } from "./RepositoryRow";
import { InventoryCaptureAction, InventoryCaptureConfirmation } from "./InventoryCapture";

export function InventorySetupRow({ repository, provider, desktop, confirming, capturing, feedback, onConfirm, onCancel, onCapture, onOpen }: {
  repository: RepositorySummary;
  provider: RepositoryProviderInventory;
  desktop: boolean;
  confirming: boolean;
  capturing: boolean;
  feedback: ProviderFeedback | null;
  onConfirm: () => void;
  onCancel: () => void;
  onCapture: () => void;
  onOpen: () => void;
}) {
  const revision = provider.currentRevision;
  const busy = capturing || provider.status === "capturing";
  const state = busy ? { label: "Capturing", tone: "warning" } : provider.status === "failed" ? { label: "Failed", tone: "negative" } : provider.status === "unavailable" ? { label: "Unavailable", tone: "neutral" } : revision ? { label: `${revision.id} saved`, tone: "info" } : { label: "Not captured", tone: "neutral" };
  return <>
    <RepositoryRow title="Context inventory" label={state.label} tone={state.tone} feedback={feedback}
      detail={<>{provider.status === "failed" ? <span className="repositoryInventoryError">{failureMessage(provider.failureKind)} · no data saved</span> : busy ? "Previous revision remains available until commit" : provider.status === "unavailable" ? "Pomegr will not combine or approximate Claude Code evidence." : <>Native diagnostic of what this repository loads into every session{revision && <> · <span className="repositoryInventoryTokens">{compactNumber(revision.machineryTokens)}</span> estimated tokens</>}</>}</>}
      actions={<>
        {revision && <button type="button" className="commandQuietAction" onClick={onOpen}>Open inventory</button>}
        <InventoryCaptureAction provider={provider} desktop={desktop} busy={busy} onConfirm={onConfirm} />
      </>} />
    {confirming && <InventoryCaptureConfirmation repository={repository} provider={provider} busy={busy} onCancel={onCancel} onCapture={onCapture} />}
  </>;
}
