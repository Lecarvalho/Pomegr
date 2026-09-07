import { useEffect, useRef, useState } from "react";
import type { ProviderId, RepositoryProviderInventory, RepositorySummary } from "../../../shared/monitor-contract";
import { compactNumber, relativeTime } from "../../dashboard-utils";
import { ProviderBadge } from "../ProviderBadge";
import { CommandSelect } from "../command-center/CommandPage";
import { InventoryCaptureAction, InventoryCaptureConfirmation } from "./InventoryCapture";
import { failureMessage, type ProviderFeedback } from "./repository-setup-details";
import { RevisionEvidence } from "./RevisionEvidence";

function ProviderInventoryEvidence({ repository, provider, initialRevisionId, scrollOnMount, onSelect }: {
  repository: RepositorySummary;
  provider: RepositoryProviderInventory;
  initialRevisionId?: string;
  scrollOnMount: boolean;
  onSelect: (revisionId: string) => void;
}) {
  const section = useRef<HTMLElement>(null);
  const scrolled = useRef(false);
  const [selection, setSelection] = useState({ initial: initialRevisionId, requested: initialRevisionId });
  const requestedRevisionId = selection.initial === initialRevisionId ? selection.requested : initialRevisionId;
  const selectedRevisionId = provider.revisions.some((revision) => revision.id === requestedRevisionId)
    ? requestedRevisionId! : provider.currentRevision?.id || "";
  useEffect(() => {
    if (scrollOnMount && !scrolled.current) {
      section.current?.scrollIntoView?.({ block: "nearest" });
      scrolled.current = true;
    }
  }, [scrollOnMount]);
  const select = (revisionId: string) => { setSelection({ initial: initialRevisionId, requested: revisionId }); onSelect(revisionId); };
  const capturedAt = provider.revisions.find((revision) => revision.id === selectedRevisionId)?.capturedAt;
  const checkedAt = provider.pluginSetup?.checkedAt;
  const ready = provider.status === "current" && selectedRevisionId;
  return <section ref={section} className="repositoryInventoryProvider" aria-label={`${provider.source} context inventory`}>
    <header className="repositorySectionHead">
      <div><ProviderBadge source={provider.source} /><span>{provider.sessionCount ? `${provider.sessionCount} observed session${provider.sessionCount === 1 ? "" : "s"}` : "No observed sessions yet"}</span></div>
      {provider.revisions.length > 1 ? <label className="repositoryRevisionSelect">Revision<CommandSelect value={selectedRevisionId} onChange={(event) => select(event.currentTarget.value)}>{provider.revisions.map((revision) => <option key={revision.id} value={revision.id}>{revision.id} · {compactNumber(revision.machineryTokens)}</option>)}</CommandSelect></label> : (capturedAt || checkedAt) && <span className="repositoryChecked">{capturedAt ? "Captured" : "Checked"} {relativeTime((capturedAt || checkedAt)!)}</span>}
    </header>
    {ready ? <RevisionEvidence repository={repository} provider={provider} selectedRevisionId={selectedRevisionId} onSelect={select} /> : <div className="repositoryInventoryState">
      <span className={`commandChip ${provider.status === "failed" ? "negative" : provider.status === "capturing" ? "warning" : ""}`}>{provider.status === "not_captured" ? "Not captured" : provider.status === "capturing" ? "Capturing" : provider.status === "failed" ? "Failed" : "Unavailable"}</span>
      <span className={provider.status === "failed" ? "repositoryInventoryError" : undefined}>{provider.status === "failed" ? `${failureMessage(provider.failureKind)} · no data saved` : provider.status === "capturing" ? "Previous revision remains available until commit" : provider.status === "unavailable" ? "Pomegr will not combine or approximate Claude Code evidence." : "Native provider diagnostic"}</span>
    </div>}
  </section>;
}

export function RepositoryInventoryTab({ repository, initialProvider, initialRevisionId, desktop, confirming, captureKey, feedback, onProvider, onRevision, onConfirm, onCancel, onCapture }: {
  repository: RepositorySummary;
  initialProvider?: ProviderId;
  initialRevisionId?: string;
  desktop: boolean;
  confirming: ProviderId | null;
  captureKey: string | null;
  feedback: ProviderFeedback | null;
  onProvider: (provider: ProviderId) => void;
  onRevision: (provider: ProviderId, revisionId: string) => void;
  onConfirm: (provider: ProviderId) => void;
  onCancel: () => void;
  onCapture: (provider: RepositoryProviderInventory) => void;
}) {
  const providers = repository.providers.filter((provider) => provider.supported);
  const selected = providers.find((provider) => provider.provider === initialProvider) || providers[0];
  const confirmation = providers.find((provider) => provider.provider === confirming);
  const captureFeedback = feedback && providers.some((provider) => feedback.key === `${repository.id}:${provider.provider}:inventory`) ? feedback : null;
  return <>
    <div className="repositoryPaneHead">
      <div><h2>Context inventory</h2><p>A native provider diagnostic of what this repository loads into every session: instructions, skills, hooks, and MCP definitions. Only normalized totals are saved.</p></div>
      {selected && <div className="repositoryInventoryCaptureActions">
        {providers.length > 1 && <CommandSelect aria-label="Capture provider" value={selected.provider} onChange={(event) => onProvider(event.currentTarget.value as ProviderId)}>{providers.map((provider) => <option key={provider.provider} value={provider.provider}>{provider.source}</option>)}</CommandSelect>}
        <InventoryCaptureAction provider={selected} desktop={desktop} busy={Boolean(captureKey)} onConfirm={() => onConfirm(selected.provider)} />
      </div>}
    </div>
    {confirmation && <InventoryCaptureConfirmation repository={repository} provider={confirmation} busy={Boolean(captureKey)} onCancel={onCancel} onCapture={() => onCapture(confirmation)} />}
    {captureFeedback && <p className={`repositorySetupFeedback ${captureFeedback.tone}`} role="status">{captureFeedback.message}</p>}
    {providers.map((provider) => <ProviderInventoryEvidence key={provider.provider} repository={repository} provider={provider} initialRevisionId={initialProvider === provider.provider ? initialRevisionId : undefined} scrollOnMount={initialProvider === provider.provider && Boolean(initialRevisionId)} onSelect={(revisionId) => onRevision(provider.provider, revisionId)} />)}
    {!providers.length && <p className="repositoryInventoryUnavailable">Context inventory is unavailable for the observed providers.</p>}
  </>;
}
