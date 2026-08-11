"use client";

import { useCallback, useRef, useState } from "react";
import type { ContextMachinery } from "../../../shared/monitor-contract";
import { compactNumber } from "../../dashboard-utils";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { PopoverFrame } from "../PopoverFrame";

export function MachineryPanel({ machinery, supported, historical }: { machinery: ContextMachinery | null | undefined; supported: boolean; historical: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissibleLayer(open, rootRef, close);
  return (
    <section className={`panel cachePanel ${open ? "machineryPopoverOpen" : ""}`} aria-label="Loaded session context">
      <div className="cacheLead"><h2>Loaded context</h2><p>Provider-estimated context used by tools, instructions, and other session components.</p></div>
      <div className="machineryStat" ref={rootRef}>
        <span>Estimated token load</span>
        {supported && machinery ? <>
          <strong title="Sum of the provider-estimated context categories in the latest /context snapshot. Messages and free space are excluded.">{compactNumber(machinery.machineryTokens)}</strong>
          <small>Estimated tokens across {machinery.categories.length} {machinery.categories.length === 1 ? "category" : "categories"}</small>
          <button className="machineryPopoverTrigger" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="loaded-machinery-popover">View context breakdown <span aria-hidden="true">▸</span></button>
          {open && (
            <PopoverFrame id="loaded-machinery-popover" ariaLabel="Loaded context breakdown" eyebrow="CONTEXT BREAKDOWN" title="Estimated token inventory" closeLabel="Close context breakdown" onClose={close} className="metricPopover machineryPopover">
              <div className="machineryPopoverBody">
                <div className="machineryMeta"><span>Provider <code>/context</code> estimate</span><strong>{machinery.model}</strong></div>
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
        </> : <><strong>—</strong><small>{!supported
          ? "Loaded context details are not available for this provider"
          : historical ? "No context snapshot was recorded" : "Run /context in the active session to measure the loaded context"}</small></>}
      </div>
    </section>
  );
}
