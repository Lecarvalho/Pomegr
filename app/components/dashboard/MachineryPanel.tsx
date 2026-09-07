"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import type { ContextInventoryReference, ContextMachinery } from "../../../shared/monitor-contract";
import { compactNumber } from "../../dashboard-utils";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { inventoryDisplayTokens } from "../context-inventory/ContextAllocationBreakdown";
import { PopoverFrame } from "../PopoverFrame";

export function MachineryPanel({ machinery, supported, inventoryRef }: { machinery: ContextMachinery | null | undefined; supported: boolean; historical: boolean; inventoryRef?: ContextInventoryReference | null }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissibleLayer(open, rootRef, close);
  if (!supported && !inventoryRef) return null;
  if (!machinery) {
    if (!inventoryRef) return null;
    const params = new URLSearchParams({ tab: "inventory", provider: inventoryRef.provider, revision: inventoryRef.revisionId });
    const source = inventoryRef.provider === "claude" ? "Claude Code" : "Codex";
    return <section className="panel sessionInventoryReference" aria-label="Repository context inventory reference"><div><strong>{source} inventory · {compactNumber(inventoryDisplayTokens(inventoryRef))} {inventoryRef.contextAllocation ? "estimated initial tokens" : "categorized tokens"}</strong><span>Immutable revision {inventoryRef.revisionId} · available when this session started · {inventoryRef.categoryCount} categories</span>{!inventoryRef.detailRetained && <small>Detailed evidence is no longer retained.</small>}</div><Link href={`/repositories/${inventoryRef.repositoryId}?${params}`}>Open {inventoryRef.revisionId}</Link></section>;
  }
  return (
    <section className={`panel cachePanel ${open ? "machineryPopoverOpen" : ""}`} aria-label="Context inventory">
      <div className="cacheLead"><h2>Context inventory</h2><p>Provider <code>/context</code> estimate split by what is initially loaded, available on demand, or reserved. Separate from agent request context.</p></div>
      <div className="machineryStat" ref={rootRef}>
        <span>Estimated initial context</span>
        <strong title="Provider-estimated context loaded before conversation content. Deferred definitions and reserved compaction capacity are excluded.">{compactNumber(machinery.contextAllocation.initialTokens)}</strong>
        <small>{compactNumber(machinery.machineryTokens)} categorized total across {machinery.categories.length} {machinery.categories.length === 1 ? "category" : "categories"}</small>
          <button className="machineryPopoverTrigger" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="loaded-machinery-popover">View inventory breakdown <span aria-hidden="true">▸</span></button>
          {open && (
            <PopoverFrame id="loaded-machinery-popover" ariaLabel="Loaded context breakdown" eyebrow="CONTEXT BREAKDOWN" title="Estimated token inventory" closeLabel="Close context breakdown" onClose={close} className="machineryPopover">
              <div className="machineryPopoverBody">
                <div className="machineryMeta"><span>Diagnostic · provider <code>/context</code> snapshot</span><strong>{machinery.model}</strong></div>
                <div className="machineryAllocation" aria-label="Provider-estimated context allocation">
                  <div><span>Loaded initially</span><strong>{compactNumber(machinery.contextAllocation.initialTokens)}</strong></div>
                  <div><span>Deferred until needed</span><strong>{compactNumber(machinery.contextAllocation.deferredTokens)}</strong></div>
                  <div><span>Reserved capacity</span><strong>{compactNumber(machinery.contextAllocation.reservedTokens)}</strong></div>
                </div>
                <div className="machineryCategories" role="list" aria-label="Estimated context categories">{machinery.categories.map((category) => (
                  <div className={`machineryCategory ${category.kind}`} role="listitem" key={category.name}><span>{category.name}</span><strong>{category.tokens}</strong><small>{category.percentage}% · {category.kind}</small></div>
                ))}</div>
                {machinery.groups.length > 0 && <div className="machineryGroups">{machinery.groups.map((group) => (
                  <details className="machineryGroup" key={group.id}>
                    <summary><strong>{group.label}</strong><span>{group.items.length} {group.items.length === 1 ? "item" : "items"}</span></summary>
                    <div className="machineryItems">{group.items.map((item, index) => <div className="machineryItem" key={`${item.name}-${item.detail}-${index}`}><div><strong>{item.name}</strong><span>{item.detail}</span></div><b>{item.tokens}</b></div>)}</div>
                  </details>
                ))}</div>}
                <p className="machineryCaution">Derived from the provider&apos;s rendered <code>/context</code> output. Values are estimates; deferred definitions are loaded on demand and reserved capacity is not prompt content. Paths and fields are sanitized before entering the browser API.</p>
              </div>
            </PopoverFrame>
          )}
      </div>
    </section>
  );
}
