import type { RepositoryProviderInventory, RepositorySummary } from "../../../shared/monitor-contract";

export function InventoryCaptureAction({ provider, desktop, busy, onConfirm }: {
  provider: RepositoryProviderInventory;
  desktop: boolean;
  busy: boolean;
  onConfirm: () => void;
}) {
  if (!provider.supported) return null;
  const label = provider.status === "failed" ? "Retry diagnostic" : provider.currentRevision ? "Capture again" : "Capture inventory";
  return desktop ? <button type="button" className="commandSecondaryAction" disabled={busy || provider.status === "capturing"} onClick={onConfirm}>{label}</button> : <span className="repositoryProviderRemoteHint">Capture available in Pomegr desktop</span>;
}

export function InventoryCaptureConfirmation({ repository, provider, busy, onCancel, onCapture }: {
  repository: RepositorySummary;
  provider: RepositoryProviderInventory;
  busy: boolean;
  onCancel: () => void;
  onCapture: () => void;
}) {
  return <div className="repositoryCaptureConfirm" role="group" aria-label={`Confirm ${provider.source} inventory capture`}><span><strong>Run a {provider.source} diagnostic for {repository.displayName}?</strong><small>Starts a local diagnostic process and saves only normalized inventory as a new immutable revision.</small></span><span><button type="button" className="commandSecondaryAction" onClick={onCancel}>Cancel</button><button type="button" className="commandPrimaryAction" disabled={busy || provider.status === "capturing"} onClick={onCapture}>Run diagnostic</button></span></div>;
}
