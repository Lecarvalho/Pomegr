import { useEffect, useState } from "react";
import type { ContextInventoryRevisionDetail, RepositoryProviderInventory, RepositorySummary } from "../../../shared/monitor-contract";
import { compactNumber, relativeTime } from "../../dashboard-utils";
import { fetchRepositoryInventoryDetail } from "../../repository-inventory-client";
import { CommandSelect } from "../command-center/CommandPage";

export function RevisionEvidence({ repository, provider, selectedRevisionId, onSelect }: {
  repository: RepositorySummary;
  provider: RepositoryProviderInventory;
  selectedRevisionId: string;
  onSelect: (revisionId: string) => void;
}) {
  const requestKey = `${repository.id}:${provider.provider}:${selectedRevisionId}`;
  const [loaded, setLoaded] = useState<{ key: string; detail: ContextInventoryRevisionDetail | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchRepositoryInventoryDetail(repository.id, provider.provider, selectedRevisionId, controller.signal)
      .then((detail) => { if (!controller.signal.aborted) setLoaded({ key: requestKey, detail }); }, () => { if (!controller.signal.aborted) setLoaded({ key: requestKey, detail: null }); });
    return () => controller.abort();
  }, [provider.provider, repository.id, requestKey, selectedRevisionId]);
  const detail = loaded?.key === requestKey ? loaded.detail : null;
  if (loaded?.key !== requestKey) return <p className="repositoryInventoryLoading">Loading saved inventory…</p>;
  if (!detail) return <p className="repositoryInventoryUnavailable">Detailed evidence is no longer retained for this revision.</p>;
  const current = provider.currentRevision;
  return <div className="repositoryInventoryEvidence">
    <section className="repositoryInventorySummary" aria-label={`${provider.source} inventory summary`}>
      <div><span>Captured</span><strong>{relativeTime(detail.capturedAt)}</strong></div>
      <div><span>Model</span><strong>{detail.model}</strong></div>
      <div><span>Revision</span><strong>{detail.id}</strong></div>
      <div><span>Estimated setup</span><strong className="repositoryInventoryTokens">{compactNumber(detail.machineryTokens)} tokens</strong></div>
    </section>
    {detail.change.state === "first_capture" ? <p className="repositoryInventoryChange">First capture for this provider. Later captures show whether the normalized inventory changed.</p> : <p className={`repositoryInventoryChange ${detail.change.state}`}>
      {detail.change.state === "unchanged" ? "No normalized inventory change" : "Changed"} since {detail.change.previousRevisionId}.
    </p>}
    <section className="repositoryInventoryBreakdown">
      <div className="repositoryInventoryHeading"><h3>{provider.source} category breakdown</h3><span>{detail.categoryCount} categories · {detail.itemCount} listed items</span></div>
      <div className="repositoryCategoryGrid" role="list" aria-label="Estimated context categories">
        {detail.categories.map((category) => <div className="repositoryCategory" role="listitem" key={category.name}><span>{category.name}</span><strong>{category.tokens}</strong><small>{category.percentage}%</small></div>)}
      </div>
    </section>
    {detail.groups.length > 0 && <details className="repositoryInventoryDetails"><summary>Inspect {detail.itemCount} listed items</summary><div className="repositoryInventoryGroups">{detail.groups.map((group) => <section key={group.id}><h4>{group.label}</h4>{group.items.map((item, index) => <div className="repositoryInventoryItem" key={`${item.name}-${index}`}><span><strong>{item.name}</strong><small>{item.detail}</small></span><b>{item.tokens}</b></div>)}</section>)}</div></details>}
    {provider.revisions.length > 1 && <details className="repositoryInventoryDetails"><summary>Compare revisions</summary><div className="repositoryRevisionCompare"><label>Revision<CommandSelect value={selectedRevisionId} onChange={(event) => onSelect(event.currentTarget.value)}>{provider.revisions.map((revision) => <option value={revision.id} key={revision.id}>{revision.id} · {compactNumber(revision.machineryTokens)}</option>)}</CommandSelect></label>{current && current.id !== detail.id && <dl><div><dt>Estimated setup</dt><dd>{compactNumber(detail.machineryTokens - current.machineryTokens)} vs current</dd></div><div><dt>Categories</dt><dd>{detail.categoryCount - current.categoryCount} vs current</dd></div><div><dt>Listed items</dt><dd>{detail.itemCount - current.itemCount} vs current</dd></div></dl>}</div></details>}
    <p className="repositoryInventoryPrivacy">Raw provider output never enters browser state or persistence. Only bounded normalized evidence is saved.</p>
  </div>;
}
