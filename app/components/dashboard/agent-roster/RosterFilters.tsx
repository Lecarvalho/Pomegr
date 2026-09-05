"use client";

import { useRef } from "react";
import { CommandSelect } from "../../command-center/CommandPage";

export type RosterFilters = { search: string; grouped: boolean; status: string; model: string; hideFinished: boolean; sort: string };
export const DEFAULT_FILTERS: RosterFilters = { search: "", grouped: true, status: "all", model: "all", hideFinished: false, sort: "provider" };

export function RosterFilterBar({ filters, models, onChange, allowGrouping = true }: { filters: RosterFilters; models: string[]; onChange: (filters: RosterFilters) => void; allowGrouping?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const change = <K extends keyof RosterFilters>(key: K, value: RosterFilters[K]) => onChange({ ...filters, [key]: value });
  const count = Number(allowGrouping && !filters.grouped) + Number(filters.status !== "all") + Number(filters.model !== "all") + Number(filters.hideFinished) + Number(filters.sort !== "provider");
  const controls = <>
    {allowGrouping && <button type="button" aria-pressed={filters.grouped} onClick={() => change("grouped", !filters.grouped)}>Group by workflow</button>}
    <CommandSelect aria-label="Agent status" value={filters.status} onChange={(event) => change("status", event.target.value)}>{["all", "active", "idle", "finished", "stopped"].map((status) => <option key={status} value={status}>Status · {status}</option>)}</CommandSelect>
    <CommandSelect aria-label="Agent model" value={filters.model} onChange={(event) => change("model", event.target.value)}><option value="all">Model · all</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</CommandSelect>
    <button type="button" aria-pressed={filters.hideFinished} onClick={() => change("hideFinished", !filters.hideFinished)} title="Hide finished and stopped subagents. Ancestors of visible agents remain shown.">Hide finished</button>
    <label className="rosterSort">Sort <CommandSelect aria-label="Sort agents" value={filters.sort} onChange={(event) => change("sort", event.target.value)}><option value="provider">Provider order</option><option value="context">Final context desc</option><option value="wall">Wall time desc</option><option value="calls">Tool calls desc</option></CommandSelect></label>
  </>;
  return <div className="rosterFilterBar">
    <input aria-label="Filter agents" placeholder="Filter agents" type="search" value={filters.search} onChange={(event) => change("search", event.target.value)} />
    <div className="rosterDesktopFilters">{controls}</div>
    <button className="rosterPhoneFilters" ref={trigger} type="button" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>Filters {count}</button>
    <dialog className="rosterFilterSheet" ref={dialog} aria-label="Agent filters" onClose={() => trigger.current?.focus()} onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
      <div className="rosterFilterSheetBody"><h3>Agent filters</h3>{controls}<button type="button" className="rosterFiltersDone" onClick={() => dialog.current?.close()}>Done</button></div>
    </dialog>
  </div>;
}
