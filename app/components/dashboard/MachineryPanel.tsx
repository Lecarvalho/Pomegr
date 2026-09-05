"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import type { ContextInventoryReference, ContextMachinery } from "../../../shared/monitor-contract";
import { compactNumber } from "../../dashboard-utils";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { PopoverFrame } from "../PopoverFrame";

export function MachineryPanel({ machinery, supported, inventoryRef }: { machinery: ContextMachinery | null | undefined; supported: boolean; historical: boolean; inventoryRef?: ContextInventoryReference | null }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissibleLayer(open, rootRef, close);
  if (!supported && !inventoryRef) return null;
  if (!machinery) {
    if (!inventoryRef) return null;
    const params = new URLSearchParams({ repository: inventoryRef.repositoryId, provider: inventoryRef.provider, revision: inventoryRef.revisionId });
    const source = inventoryRef.provider === "claude" ? "Claude Code" : "Codex";
    return <section className="panel sessionInventoryReference" aria-label="Repository context inventory reference"><div><strong>{source} inventory · {compactNumber(inventoryRef.machineryTokens)} estimated setup tokens</strong><span>Immutable revision {inventoryRef.revisionId} · available when this session started · {inventoryRef.categoryCount} categories</span>{!inventoryRef.detailRetained && <small>Detailed evidence is no longer retained.</small>}</div><Link href={`/repositories?${params}`}>Open {inventoryRef.revisionId}</Link></section>;
  }
  return (
    <section className={`panel cachePanel ${open ? "machineryPopoverOpen" : ""}`} aria-label="Loaded context inventory">
      <div className="cacheLead"><h2>Loaded context inventory</h2><p>Provider <code>/context</code> estimate of instructions, tools, skills, and other loaded components. Separate from agent request context.</p></div>
      <div className="machineryStat" ref={rootRef}>
        <span>Estimated loaded components</span>
        <strong title="Sum of the provider-estimated context categories in the latest /context snapshot. Messages and free space are excluded.">{compactNumber(machinery.machineryTokens)}</strong>
        <small>Estimated tokens across {machinery.categories.length} {machinery.categories.length === 1 ? "category" : "categories"}</small>
          <button className="machineryPopoverTrigger" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="loaded-machinery-popover">View inventory breakdown <span aria-hidden="true">▸</span></button>
          {open && (
            <PopoverFrame id="loaded-machinery-popover" ariaLabel="Loaded context breakdown" eyebrow="CONTEXT BREAKDOWN" title="Estimated token inventory" closeLabel="Close context breakdown" onClose={close} className="metricPopover machineryPopover">
              <div className="machineryPopoverBody">
                <div className="machineryMeta"><span>Diagnostic · provider <code>/context</code> snapshot</span><strong>{machinery.model}</strong></div>
                <div className="machineryCategories" role="list" aria-label="Estimated context categories">{machinery.categories.map((category) => (
                  <div className="machineryCategory" role="listitem" key={category.name}><span>{category.name}</span><strong>{category.tokens}</strong><small>{category.percentage}%</small></div>
                ))}</div>
                {machinery.groups.length > 0 && <div className="machineryGroups">{machinery.groups.map((group) => (
                  <details className="machineryGroup" key={group.id}>
                    <summary><strong>{group.label}</strong><span>{group.items.length} {group.items.length === 1 ? "item" : "items"}</span></summary>
                    <div className="machineryItems">{group.items.map((item, index) => <div className="machineryItem" key={`${item.name}-${item.detail}-${index}`}><div><strong>{item.name}</strong><span>{item.detail}</span></div><b>{item.tokens}</b></div>)}</div>
                  </details>
                ))}</div>}
                <p className="machineryCaution">Loaded from the provider&apos;s rendered <code>/context</code> output. Values are estimates; paths and fields are sanitized before entering the browser API.</p>
              </div>
            </PopoverFrame>
          )}
      </div>
    </section>
  );
}
