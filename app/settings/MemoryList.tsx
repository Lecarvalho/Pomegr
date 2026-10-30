"use client";

import { useState } from "react";
import { ARIL_MEMORY, fitMemory, isMemoryLine } from "../../shared/aril-memory.mjs";

export type MemoryListEntry = { id: number; text: string; createdAt: number };

/**
 * Aril's memory lines, oldest first, with the counter and the edit, delete, and add rows: the same list for a repository's memory and for
 * the owner's. `scope` words the field names ("" or "your "), so two lists on one page keep distinct names. A read-only list has no
 * action. The caller says whether a change was accepted and shows its failure; a change that was not accepted keeps what was typed.
 */
export function MemoryList({ entries, editable, busy, caption, scope = "", onAdd, onUpdate, onRemove }: {
  entries: readonly MemoryListEntry[];
  editable: boolean;
  busy: boolean;
  caption: string;
  scope?: string;
  onAdd(text: string): Promise<boolean>;
  onUpdate(id: number, text: string): Promise<boolean>;
  onRemove(id: number): Promise<boolean>;
}) {
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const fit = fitMemory(entries);
  const full = entries.length >= ARIL_MEMORY.entries;
  return <>
    <p className="taskGatesCaption">{caption}</p>
    <p className="taskGatesCaption">{`${entries.length} of ${ARIL_MEMORY.entries}`}</p>
    {fit.omitted > 0 && <p className="taskGatesCaption">{`Aril reads the newest ${fit.entries.length} lines. The ${fit.omitted} older ${fit.omitted === 1 ? "line does" : "lines do"} not fit its limit of ${ARIL_MEMORY.promptLength.toLocaleString("en-US")} characters.`}</p>}
    {entries.length === 0 && <p className="taskGatesCaption">No memory entries yet.</p>}
    {entries.map((entry) => <div className="taskGateField" key={entry.id}>
      {editable && editing?.id === entry.id ? <>
        <input aria-label={`Edit ${scope}entry`} className="taskOwnInput arilMemoryField" value={editing.text} maxLength={ARIL_MEMORY.entryLength} disabled={busy} onChange={(event) => setEditing({ ...editing, text: event.currentTarget.value })} />
        <div className="taskHeadActions"><button type="button" className="commandSecondaryAction" disabled={busy || !isMemoryLine(editing.text)} onClick={() => void onUpdate(editing.id, editing.text).then((ok) => { if (ok) setEditing(null); })}>Save entry</button>
          <button type="button" className="commandQuietAction" disabled={busy} onClick={() => setEditing(null)}>Cancel edit</button></div>
      </> : <p className="taskGateReadOnly">{entry.text}</p>}
      {editable && editing?.id !== entry.id && <div className="taskHeadActions">
        {removing === entry.id ? <><span>Delete this entry?</span><button type="button" className="commandSecondaryAction" disabled={busy} onClick={() => void onRemove(entry.id).then((ok) => { if (ok) setRemoving(null); })}>Delete entry</button>
          <button type="button" className="commandQuietAction" disabled={busy} onClick={() => setRemoving(null)}>Keep entry</button></>
          : <><button type="button" className="commandQuietAction" disabled={busy} onClick={() => { setEditing({ id: entry.id, text: entry.text }); setRemoving(null); }}>Edit</button>
            <button type="button" className="commandQuietAction" disabled={busy} onClick={() => { setRemoving(entry.id); setEditing(null); }}>Delete</button></>}
      </div>}
    </div>)}
    {editable && <><label className="taskGateField"><span className="taskGateFieldLabel">{`Add ${scope}entry`}</span><input className="taskOwnInput arilMemoryField" value={adding} maxLength={ARIL_MEMORY.entryLength} disabled={busy || full} onChange={(event) => setAdding(event.currentTarget.value)} /></label>
      <button type="button" className="commandSecondaryAction" disabled={busy || full || !isMemoryLine(adding)} onClick={() => void onAdd(adding).then((ok) => { if (ok) setAdding(""); })}>Add entry</button></>}
  </>;
}
