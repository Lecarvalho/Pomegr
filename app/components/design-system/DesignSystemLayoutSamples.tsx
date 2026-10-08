"use client";

import { useState } from "react";
import { CommandTable, type CommandTableColumn } from "../command-center/CommandTable";
import { CommandEmpty, CommandIcon, CommandStatus } from "../command-center/CommandPage";
import { Sample, Section } from "./DesignSystemKit";

// Fixed display strings keep server and client markup identical regardless of time zone.
type TableRow = { id: string; title: string; detail: string; agents: number; updated: string; updatedLabel: string; status: string; tone: "positive" | "warning" | "neutral" };
const TABLE_ROWS: TableRow[] = ([
  ["Audit session readiness states", "Pomegr · main", 6, "2026-08-09T14:10:00Z", "Aug 9, 14:10", "Working", "positive"],
  ["Add request activity navigation", "Pomegr · docs/migration", 4, "2026-08-09T11:42:00Z", "Aug 9, 11:42", "Needs input", "warning"],
  ["Introduce the repository panel", "Pomegr · main", 9, "2026-08-08T16:05:00Z", "Aug 8, 16:05", "Closed", "neutral"],
  ["Clarify cache timing copy", "Pokrr · main", 2, "2026-08-08T09:30:00Z", "Aug 8, 09:30", "Closed", "neutral"],
  ["Split the signals tab", "Catalogus · main", 3, "2026-08-07T18:22:00Z", "Aug 7, 18:22", "Idle", "neutral"],
  ["Map dashboard components", "Pomegr · main", 5, "2026-08-07T10:01:00Z", "Aug 7, 10:01", "Closed", "neutral"],
  ["Tighten phone filters", "Pokrr · main", 1, "2026-08-06T15:48:00Z", "Aug 6, 15:48", "Closed", "neutral"],
  ["Review the lane collapse diff", "Pomegr · main", 7, "2026-08-06T08:12:00Z", "Aug 6, 08:12", "Idle", "neutral"],
  ["Plan storage settings", "Catalogus · main", 2, "2026-08-05T13:37:00Z", "Aug 5, 13:37", "Closed", "neutral"],
] satisfies [string, string, number, string, string, string, TableRow["tone"]][]).map(([title, detail, agents, updated, updatedLabel, status, tone], index) => ({ id: `row-${index}`, title, detail, agents, updated, updatedLabel, status, tone }));

const TABLE_COLUMNS: CommandTableColumn<TableRow>[] = [
  { id: "session", label: "Session", renderCell: (row) => <span className="commandTablePrimary"><strong>{row.title}</strong><small>{row.detail}</small></span>, sortValue: (row) => row.title },
  { id: "agents", label: "Agents", renderCell: (row) => <span className="commandTableProgress">{row.agents}</span>, sortValue: (row) => row.agents },
  { id: "updated", label: "Updated", className: "commandTableUpdated", renderCell: (row) => row.updatedLabel, sortValue: (row) => Date.parse(row.updated) },
  { id: "status", label: "Status", renderCell: (row) => <span className={`commandChip ${row.tone}`}><i aria-hidden="true" />{row.status}</span> },
];

export function CommandTableSection() {
  const [page, setPage] = useState(1);
  const rowKey = (row: TableRow) => row.id;
  return <Section id="command-table" title="Command table" lede="CommandTable is the shared table: a sortable header per column, an optional pagination footer, and a caller-supplied empty state. Sorting runs before pagination and keeps missing values last in either direction.">
    <CommandTable caption="Sample sessions" className="designSystemTable" rows={TABLE_ROWS} columns={TABLE_COLUMNS} getRowKey={rowKey} pagination={{ page, pageSize: 4, onPageChange: setPage, label: "Sample session pages" }} />
    <p className="designSystemNote">Sortable headers start unsorted with a two-arrow glyph. The first click sorts descending, the next ascending, and the active header takes ink text, a single-arrow glyph, and aria-sort; Status has no sort value, so it stays a plain header. Focus draws an inset ring. The footer summarizes the visible range with Previous, page numbers (aria-current on the current page), and Next as secondary actions, and appears only with more than one page. At 760px and narrower it stacks into full-width Previous and Next with a Page N of M line. The table scrolls inside its frame when it is wider than its container.</p>
    <CommandTable caption="Grouped sample sessions" className="designSystemTable" rows={[]} columns={TABLE_COLUMNS.map((column) => ({ ...column, sortValue: undefined }))} getRowKey={rowKey} rowGroups={[
      { key: "open", header: <button className="commandQuietAction commandSessionGroupToggle" type="button" aria-expanded="true"><CommandIcon name="chevron" size="small" /><strong>pomegr</strong><span className="commandSessionGroupCount">7 sessions</span><CommandStatus state="active">2 live</CommandStatus><CommandStatus state="attention">1 needs input</CommandStatus><span className="commandSessionGroupLatest">Updated 2m ago</span></button>, rows: TABLE_ROWS.slice(0, 2), footer: <button className="commandTextLink" type="button">Show all 7 in pomegr</button> },
      { key: "closed", header: <button className="commandQuietAction commandSessionGroupToggle" type="button" aria-expanded="false"><CommandIcon name="chevron" size="small" /><strong>catalogus</strong><span className="commandSessionGroupCount">3 sessions</span><span className="commandSessionGroupLatest">Updated 1h ago</span></button>, rows: [] },
    ]} />
    <p className="designSystemNote">Row groups replace the flat body with one section per group, in the caller&apos;s order, without sorting or pagination. Each section opens with a full-width header cell holding a quiet toggle: a chevron that turns when open, the group name, data-font counts, live and needs-input status only when present, and the newest update on the right. A collapsed group keeps its header and drops its rows. A group with more rows than it shows ends in one text link.</p>
    <div className="designSystemGrid">
      <Sample label="Empty · default" note="Without emptyState the table renders the quiet unavailable note.">
        <CommandTable caption="Empty sample" rows={[]} columns={TABLE_COLUMNS} getRowKey={rowKey} />
      </Sample>
      <Sample label="Empty · CommandEmpty" note="Callers pass CommandEmpty when filters can match nothing; keep the table mounted so the sort choice survives.">
        <CommandTable caption="Filtered sample" rows={[]} columns={TABLE_COLUMNS} getRowKey={rowKey} emptyState={<CommandEmpty icon="agents" title="No sessions match these filters" detail="Try another state or search term." />} />
      </Sample>
    </div>
  </Section>;
}

const RAIL_TABS = [
  { id: "appearance", label: "Appearance", detail: "Controls on these rows affect only this local interface." },
  { id: "providers", label: "Providers", detail: "Bounded source selection and folder availability; native dialogs show paths." },
  { id: "storage", label: "Storage", detail: "Retention and cleanup threshold, applied on the monitor's next prune cycle." },
];

export function SettingsRailSection() {
  const [selected, setSelected] = useState(RAIL_TABS[0].id);
  const tab = RAIL_TABS.find((item) => item.id === selected) ?? RAIL_TABS[0];
  return <Section id="settings-rail" title="Settings tab rail" lede="Settings and the repository detail route share one layout: a 210px vertical tab rail beside a pane, which becomes a horizontally scrolling strip at 760px and narrower. The active tab takes the raised tone and ink text.">
    <div className="commandSettingsLayout">
      <div className="commandSettingsNav" role="tablist" aria-label="Sample sections">
        {RAIL_TABS.map((item) => <button key={item.id} type="button" role="tab" id={`design-system-rail-${item.id}`} aria-selected={item.id === tab.id} aria-controls="design-system-rail-panel" className={item.id === tab.id ? "active" : ""} onClick={() => setSelected(item.id)}>{item.label}</button>)}
      </div>
      <div className="commandSettingsPane" role="tabpanel" id="design-system-rail-panel" aria-labelledby={`design-system-rail-${tab.id}`}>
        <h2>{tab.label}</h2>
        <p>{tab.detail}</p>
        <div className="commandSettingRow"><div><strong>Row with a rule</strong><span>Panes compose .commandSettingRow and the button roles.</span></div><button type="button" className="commandSecondaryAction">Configure</button></div>
      </div>
    </div>
    <p className="designSystemNote">Real callers add arrow-key, Home, and End navigation, a roving tab stop, and URL state; this static sample switches panes on click only. The repository detail route adds .repositoryDetailLayout, which stacks its quiet-action tabs with a 2px gap and keeps them in a row at 760px and narrower.</p>
  </Section>;
}
