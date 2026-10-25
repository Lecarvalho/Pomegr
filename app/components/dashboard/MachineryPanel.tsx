"use client";

import Link from "next/link";
import type { ContextInventoryReference, ContextMachinery } from "../../../shared/monitor-contract";
import { compactNumber } from "../../dashboard-utils";
import { inventoryDisplayTokens } from "../context-inventory/ContextAllocationBreakdown";
import { DottedInfoPopover } from "../DottedInfoPopover";

export function MachineryPanel({ machinery, supported, inventoryRef }: { machinery: ContextMachinery | null | undefined; supported: boolean; historical: boolean; inventoryRef?: ContextInventoryReference | null }) {
  if (!supported && !inventoryRef) return null;
  const params = inventoryRef ? new URLSearchParams({ tab: "inventory", provider: inventoryRef.provider, revision: inventoryRef.revisionId }) : null;
  const revisionLink = inventoryRef && <Link className="commandQuietAction" href={`/repositories/${inventoryRef.repositoryId}?${params}`}>Repository inventory revision {inventoryRef.revisionId}</Link>;
  if (!machinery) {
    if (!inventoryRef) return null;
    const source = inventoryRef.provider === "claude" ? "Claude Code" : "Codex";
    return <section className="panel sessionContextInventory" aria-label="Context inventory">
      <header className="sessionDetailsHeader"><h2>Context inventory</h2></header>
      <div className="sessionInventoryReference">
        <strong>{source} inventory · {compactNumber(inventoryDisplayTokens(inventoryRef))} {inventoryRef.contextAllocation ? "estimated initial tokens" : "categorized tokens"}</strong>
        <p>Immutable revision {inventoryRef.revisionId} · available when this session started · {inventoryRef.categoryCount} categories</p>
        {!inventoryRef.detailRetained && <p>Detailed evidence is no longer retained.</p>}
        {revisionLink}
      </div>
    </section>;
  }
  return (
    <section className="panel sessionContextInventory" aria-label="Context inventory">
      <header className="sessionDetailsHeader">
        <h2><DottedInfoPopover ariaLabel="About context inventory" content={<p>Derived from the provider&apos;s rendered <code>/context</code> output. Values are estimates; deferred definitions are loaded on demand and reserved capacity is not prompt content. Shares are the provider-reported category percentages. Paths and fields are sanitized before entering the browser API.</p>}>Context inventory</DottedInfoPopover></h2>
        <span>Provider <code>/context</code> snapshot · {machinery.model}</span>
      </header>
      <p className="sessionInventoryIntro">What the provider loads before conversation content. Separate from agent request context.</p>
      <div className="sessionInventoryAllocation" aria-label="Provider-estimated context allocation">
        <div><span>Loaded initially</span><strong>{compactNumber(machinery.contextAllocation.initialTokens)}</strong></div>
        <div><span>Deferred until needed</span><strong>{compactNumber(machinery.contextAllocation.deferredTokens)}</strong></div>
        <div><span>Reserved capacity</span><strong>{compactNumber(machinery.contextAllocation.reservedTokens)}</strong></div>
      </div>
      <table className="sessionInventoryTable" aria-label="Estimated context categories">
        <thead><tr><th scope="col">Category</th><th scope="col">Tokens</th><th scope="col">Share</th><th scope="col">Kind</th></tr></thead>
        <tbody>{machinery.categories.map((category) => <tr key={category.name}>
          <th scope="row">{category.name}</th><td>{category.tokens}</td><td>{category.kind === "initial" ? `${category.percentage}%` : "—"}</td><td>{category.kind}</td>
        </tr>)}</tbody>
      </table>
      <div className="sessionInventoryLinks">
        {machinery.groups.length > 0 && <details className="sessionInventoryGroups">
          <summary className="commandTextLink">Groups · {machinery.groups.length}</summary>
          <div className="machineryGroups">{machinery.groups.map((group) => (
            <details className="machineryGroup" key={group.id}>
              <summary><strong>{group.label}</strong><span>{group.items.length} {group.items.length === 1 ? "item" : "items"}</span></summary>
              <div className="machineryItems">{group.items.map((item, index) => <div className="machineryItem" key={`${item.name}-${item.detail}-${index}`}><div><strong>{item.name}</strong><span>{item.detail}</span></div><b>{item.tokens}</b></div>)}</div>
            </details>
          ))}</div>
        </details>}
        {revisionLink}
      </div>
    </section>
  );
}
