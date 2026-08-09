"use client";

import { useCallback, useRef, useState } from "react";
import type { ContextMachinery } from "../../../shared/monitor-contract";
import { compactNumber } from "../../dashboard-utils";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { PopoverFrame } from "../PopoverFrame";

export function MachineryPanel({ machinery, historical }: { machinery: ContextMachinery | null | undefined; historical: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissibleLayer(open, rootRef, close);
  return (
    <section className={`panel cachePanel ${open ? "machineryPopoverOpen" : ""}`} aria-label="Primary session machinery">
      <div className="cacheLead"><span className="label">SESSION MACHINERY</span><h2>Loaded machinery</h2><p>Provider-estimated context used by tools, instructions, and other session machinery.</p></div>
      <div className="machineryStat" ref={rootRef}>
        <span>Machinery token load</span>
        {machinery ? <>
          <strong title="Sum of the provider-estimated machinery categories in the latest /context snapshot. Messages and free space are excluded.">{compactNumber(machinery.machineryTokens)}</strong>
          <small>Estimated tokens across {machinery.categories.length} {machinery.categories.length === 1 ? "category" : "categories"}</small>
          <button className="machineryPopoverTrigger" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="loaded-machinery-popover">View loaded machinery <span aria-hidden="true">▸</span></button>
          {open && (
            <PopoverFrame id="loaded-machinery-popover" ariaLabel="Loaded context machinery" eyebrow="MACHINERY BREAKDOWN" title="Token inventory" closeLabel="Close loaded machinery" onClose={close} className="metricPopover machineryPopover">
              <div className="machineryPopoverBody">
                <div className="machineryMeta"><span>Claude <code>/context</code> estimate</span><strong>{machinery.model}</strong></div>
                <div className="machineryCategories" role="list" aria-label="Estimated machinery categories">{machinery.categories.map((category) => (
                  <div className="machineryCategory" role="listitem" key={category.name}><span>{category.name}</span><strong>{category.tokens}</strong><small>{category.percentage}%</small></div>
                ))}</div>
                {machinery.groups.length > 0 && <div className="machineryGroups">{machinery.groups.map((group) => (
                  <details className="machineryGroup" key={group.id}>
                    <summary><strong>{group.label}</strong><span>{group.items.length} {group.items.length === 1 ? "item" : "items"}</span></summary>
                    <div className="machineryItems">{group.items.map((item, index) => <div className="machineryItem" key={`${item.name}-${item.detail}-${index}`}><div><strong>{item.name}</strong><span>{item.detail}</span></div><b>{item.tokens}</b></div>)}</div>
                  </details>
                ))}</div>}
                <p className="machineryCaution">Loaded from Claude Code&apos;s rendered <code>/context</code> output. Values are provider estimates; paths and fields are sanitized before entering the browser API.</p>
              </div>
            </PopoverFrame>
          )}
        </> : <><strong>—</strong><small>{historical ? "No machinery snapshot recorded" : "Run /context to measure loaded machinery"}</small></>}
      </div>
    </section>
  );
}
