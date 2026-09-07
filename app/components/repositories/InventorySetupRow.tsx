import type { RepositoryProviderInventory, RepositorySummary } from "../../../shared/monitor-contract";
import { compactNumber } from "../../dashboard-utils";
import { failureMessage, type ProviderFeedback } from "./repository-setup-details";
import { RepositoryRow } from "./RepositoryRow";

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
  const captureLabel = provider.status === "failed" ? "Retry diagnostic" : revision ? "Capture again" : "Capture inventory";
  return <>
    <RepositoryRow title="Context inventory" label={state.label} tone={state.tone} feedback={feedback}
      detail={<>{provider.status === "failed" ? <span className="repositoryInventoryError">{failureMessage(provider.failureKind)} · no data saved</span> : busy ? "Previous revision remains available until commit" : provider.status === "unavailable" ? "Pomegr will not combine or approximate Claude Code evidence." : <>Native diagnostic of what this repository loads into every session{revision && <> · <span className="repositoryInventoryTokens">{compactNumber(revision.machineryTokens)}</span> estimated tokens</>}</>}</>}
      actions={<>
        {revision && <button type="button" className="commandQuietAction" onClick={onOpen}>Open inventory</button>}
        {provider.supported && (desktop ? <button type="button" className="commandSecondaryAction" disabled={busy} onClick={onConfirm}>{captureLabel}</button> : <span className="repositoryProviderRemoteHint">Capture available in Pomegr desktop</span>)}
      </>} />
    {confirming && <div className="repositoryCaptureConfirm" role="group" aria-label={`Confirm ${provider.source} inventory capture`}><span><strong>Run a {provider.source} diagnostic for {repository.displayName}?</strong><small>Starts a local diagnostic process and saves only normalized inventory as a new immutable revision.</small></span><span><button type="button" className="commandSecondaryAction" onClick={onCancel}>Cancel</button><button type="button" className="commandPrimaryAction" disabled={busy} onClick={onCapture}>Run diagnostic</button></span></div>}
  </>;
}
