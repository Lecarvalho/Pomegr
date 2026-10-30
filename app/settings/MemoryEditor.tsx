"use client";

import { useId, useState } from "react";
import { ARIL_MEMORY } from "../../shared/aril-memory.mjs";

/** A memory as Settings shows it: free text, the text before the last change, and who changed it last and when (milliseconds since the epoch). */
export type MemoryView = { text: string; previous: string | null; updatedAt: number | null; updatedBy: "owner" | "aril" | null };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `at` was, in the words the footer uses. */
export function memoryAgo(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 2 * DAY) return "yesterday";
  return `${Math.floor(elapsed / DAY)} days ago`;
}

// A line as the text writes it, without the `- ` marker, so the same line compares equal whichever way it was typed.
const bare = (line: string) => line.trim().replace(/^-\s+/u, "").trim();
const linesOf = (text: string) => text.split("\n").map(bare).filter((line) => line !== "");

/** What changed between the text before and the text now, as counts of lines. */
export function memoryChange(previous: string, text: string) {
  const before = new Set(linesOf(previous));
  const after = new Set(linesOf(text));
  return { added: [...after].filter((line) => !before.has(line)).length, removed: [...before].filter((line) => !after.has(line)).length };
}

const plural = (count: number) => (count === 1 ? "a line" : `${count} lines`);

/** The footer's sentence: who changed the memory last, what they did when it is known, and when. */
export function memoryEdited(memory: MemoryView, now: number): string {
  if (memory.updatedAt === null || memory.updatedBy === null) return "Nothing saved yet";
  const when = memoryAgo(memory.updatedAt, now);
  if (memory.updatedBy === "owner") return `You edited this ${when}`;
  const { added, removed } = memory.previous === null ? { added: 0, removed: 0 } : memoryChange(memory.previous, memory.text);
  if (added > 0 && removed === 0) return `Aril added ${plural(added)} ${when}`;
  if (removed > 0 && added === 0) return `Aril removed ${plural(removed)} ${when}`;
  return `Aril updated this ${when}`;
}

/** One side of the change: every line, the ones that the other side does not have marked. */
function ChangeSide({ title, text, other }: { title: string; text: string; other: string }) {
  const rest = new Set(linesOf(other));
  const lines = text === "" ? [] : text.split("\n");
  return <div className="arilMemoryChangeSide">
    <h4>{title}</h4>
    <pre>{lines.length === 0 ? <span className="arilMemoryChangeEmpty">Empty</span> : lines.map((line, index) => <span key={index} className={`arilMemoryChangeLine${bare(line) !== "" && !rest.has(bare(line)) ? " isChanged" : ""}`}>{line === "" ? <>&nbsp;</> : line}</span>)}</pre>
  </div>;
}

/**
 * One memory as free text: a field that saves when the owner leaves it, a live count against the 6,000-character limit, and a footer that says who
 * changed it last and when. "Show change" opens the text before the last change beside the text now. A memory that is read-only has the same
 * field with no edit. The field shows no focus ring: the caret marks focus (DESIGN.md, Agent chat exceptions). `save` answers whether the text was
 * kept; a refused save keeps what was typed and says so. `now` is the time the footer counts from, so a static frame never reads the clock.
 * `disabled` is the page's Aril-is-off state: the field and **Show change** are disabled, and an edit that was open is closed.
 */
export function MemoryEditor({ memory, editable, label, caption, save, now, disabled = false, initialShowChange = false, initialFailed = false }: {
  /** Null until the memory has been read. */
  memory: MemoryView | null;
  editable: boolean;
  label: string;
  caption: string;
  save(text: string): Promise<boolean>;
  now: number;
  disabled?: boolean;
  initialShowChange?: boolean;
  initialFailed?: boolean;
}) {
  const captionId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(initialFailed);
  const [showing, setShowing] = useState(initialShowChange);
  // Turning Aril off closes an edit that is open: what was typed is dropped, since a write is refused while Aril is off.
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) { setWasDisabled(disabled); if (disabled) { setDraft(null); setFailed(false); } }
  if (memory === null) return <p className="arilCardNote" role="status">Reading memory…</p>;
  const text = draft ?? memory.text;
  const dirty = draft !== null && draft !== memory.text;
  const commit = async () => {
    if (draft === null || saving || !editable || disabled) return;
    if (draft === memory.text) { setDraft(null); return; }
    setSaving(true);
    setFailed(false);
    let kept = false;
    try { kept = await save(draft); } catch { kept = false; }
    setSaving(false);
    if (kept) setDraft(null); else setFailed(true);
  };
  const changed = !dirty && memory.previous !== null && memory.previous !== memory.text;
  return <>
    <p id={captionId} className="arilCardCaption">{caption}</p>
    <textarea className="arilMemoryField" aria-label={label} aria-describedby={captionId} value={text} readOnly={!editable || disabled} disabled={disabled} maxLength={ARIL_MEMORY.textLength} spellCheck={false}
      onChange={(event) => { setFailed(false); setDraft(event.currentTarget.value); }} onBlur={() => void commit()} />
    <div className="arilMemoryFooter">
      {memory.updatedAt !== null && !dirty && !saving && <span className="arilMemoryDot" aria-hidden="true" />}
      <span className="arilMemoryEdited" role="status">{saving ? "Saving…" : dirty ? "Saves when you leave the field" : memoryEdited(memory, now)}</span>
      {changed && <button type="button" className="commandQuietAction" aria-expanded={showing} disabled={disabled} onClick={() => setShowing(!showing)}>{showing ? "Hide change" : "Show change"}</button>}
      <span className="arilMemoryCount">{`${text.length.toLocaleString("en-US")} / ${ARIL_MEMORY.textLength.toLocaleString("en-US")}`}</span>
    </div>
    {changed && showing && memory.previous !== null && <div className="arilMemoryChange" role="group" aria-label={`Change to ${label}`}>
      <ChangeSide title="Before" text={memory.previous} other={memory.text} />
      <ChangeSide title="Now" text={memory.text} other={memory.previous} />
    </div>}
    {failed && <p className="newTaskError arilCardAlert" role="alert">Memory could not be saved. Try again.</p>}
  </>;
}
