"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { THREAD_LIMIT_MEGABYTES } from "../../shared/agent-chat-contract";
import type { ArilSwitchControl, OwnerMemoryControl, ThreadSpaceControl } from "../aril-control-client";
import { CommandSelect } from "../components/command-center/CommandSelect";
import { CommandSwitch } from "../components/command-center/CommandSwitch";
import { JEV_KEY_PATTERN, type JevKeyControl } from "../components/tasks/jev-key-desktop";
import { MemoryEditor } from "./MemoryEditor";
import { formatStorageBytes } from "./StorageSettings";

// The cards of Settings › Aril: the On/Off switch with the one paired-device permission, the memory, the space each thread takes, and the
// effort routing. Each takes the control it shows, so the live section and the static design-system frames draw the same markup.

const STATE_ON = "Keeping work moving as you settled it. Turn off to stop every action at once; running sessions keep going.";
const STATE_OFF = "Takes no action of its own. The chat still answers when you write.";

/** A thread's size in the unit that reads best: bytes, kilobytes, then the storage meter's megabytes and gigabytes. */
export function threadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return formatStorageBytes(bytes);
}

function Mark() {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
    <circle cx="12" cy="13" r="7.5" strokeWidth="1.8" /><circle cx="12" cy="13" r="2.4" fill="currentColor" stroke="none" /><path d="M9 4.5l3-2.5 3 2.5" strokeWidth="1.6" />
  </svg>;
}

/**
 * The top card of the section: the mark, the page heading with Aril's state, one line about that state, and the one switch. A soft green glow
 * shows while Aril is On. Nothing of the state is drawn until the desktop has answered, so the card never shows a state and takes it back.
 * The desktop app adds a row for the one paired-device permission (turn Aril on, and change repository memory and Aril's settings); a paired
 * device that may not turn Aril on says so there instead.
 */
export function ArilSwitchCard({ control, headingId }: { control: ArilSwitchControl; headingId: string }) {
  const pairedId = useId();
  const lineId = useId();
  const { availability, state, busy, failed, canTurnOn } = control;
  const reachable = availability === "desktop" || availability === "paired";
  const line = availability === "pending" ? null
    : !reachable ? "Turn Aril on or off in the desktop app or on a paired device."
      : state === null ? "Reading Aril…" : state.on ? STATE_ON : STATE_OFF;
  return <div className={`arilHero${state?.on ? " isOn" : ""}`}>
    <span className="arilHeroGlow" aria-hidden="true" />
    <div className="arilHeroMain">
      <span className="arilHeroMark" aria-hidden="true"><Mark /></span>
      <div className="arilHeroText">
        <div className="arilHeroTitle"><h2 id={headingId}>Aril</h2>{reachable && state !== null && <span className="arilHeroState">{state.on ? "On" : "Off"}</span>}</div>
        {line !== null && <p id={lineId} className="arilHeroLine" role={state === null && reachable ? "status" : undefined}>{line}</p>}
      </div>
      {reachable && state !== null && <CommandSwitch checked={state.on} disabled={busy || (!state.on && !canTurnOn)} aria-label="Let Aril act" aria-describedby={lineId} onChange={(next) => void control.setOn(next)} />}
    </div>
    {reachable && state !== null && availability === "desktop" && <div className="arilHeroRow">
      <span id={pairedId}>A paired phone can always turn Aril off. Let it also turn Aril on and change Aril&apos;s repository memory and settings.</span>
      <CommandSwitch small checked={state.pairedOn} disabled={busy} aria-labelledby={pairedId} onChange={(next) => void control.setPairedOn(next)} />
    </div>}
    {reachable && state !== null && availability === "paired" && !state.on && !canTurnOn && <div className="arilHeroRow"><span>Turning Aril on needs the desktop app.</span></div>}
    {failed && <div className="arilHeroRow"><span className="newTaskError" role="alert">Aril could not be changed. Try again.</span></div>}
  </div>;
}

/** A card of the section: a head with the title and one control, then the body. */
export function ArilCard({ title, headingId, aside, children, className = "" }: { title: string; headingId?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`arilCard${className ? ` ${className}` : ""}`} aria-labelledby={headingId}>
    <div className="arilCardHead"><h3 id={headingId}>{title}</h3>{aside}</div>
    {children}
  </section>;
}

/**
 * The line above everything that is read only while Aril is off: a neutral notice with a lock. It is the only change to the page when Aril turns
 * off besides the gray of the cards under it. The switch card and the line of a running grant above it stay active.
 */
export function ArilOffNotice() {
  return <p className="arilOffNotice" role="status">
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" strokeWidth="0" /><path d="M8 11V8a4 4 0 0 1 8 0v3" strokeWidth="2.2" /></svg>
    Aril is off, so everything below is read only. Turn Aril on to change it.
  </p>;
}

export type MemoryTab = { id: string; label: string };

/**
 * The Memory card: the owner's memory first, then one tab for each repository. The tab list scrolls sideways when there are many. `children` is
 * the pane of the chosen tab. Memory is context for Aril and grants it no permission; the captions say so, so it reads apart from agreements.
 */
export function ArilMemoryCard({ tabs, tab, onTab, disabled = false, children }: { tabs: readonly MemoryTab[]; tab: string; onTab(id: string): void; disabled?: boolean; children: ReactNode }) {
  const base = useId();
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null || tabs.length === 0) return;
    event.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    onTab(target.id);
    document.getElementById(`${base}-${target.id}`)?.focus();
  };
  return <ArilCard title="Memory" aside={tabs.length > 1 ? <div className="arilTabs" role="tablist" aria-label="Memory">
    {tabs.map((entry, index) => <button key={entry.id} id={`${base}-${entry.id}`} type="button" role="tab" aria-selected={entry.id === tab} tabIndex={entry.id === tab ? 0 : -1}
      aria-controls={`${base}-panel`} className="arilTab" disabled={disabled} onClick={() => onTab(entry.id)} onKeyDown={(event) => move(event, index)}>{entry.label}</button>)}
  </div> : undefined}>
    <div id={`${base}-panel`} className="arilCardBody" {...(tabs.length > 1 ? { role: "tabpanel", "aria-labelledby": `${base}-${tab}` } : {})}>{children}</div>
  </ArilCard>;
}

export const OWNER_MEMORY_CAPTION = "How you like things done, in every repository. Context for Aril, not permission: it lets Aril do nothing new. Aril keeps it current; edit anything.";
export const repositoryMemoryCaption = (name: string) => `How things are done in ${name}. Context for Aril, not permission. Aril keeps it current; edit anything.`;

/** The owner's memory: a paired device reads it, and only the desktop app edits it. */
export function OwnerMemoryPane({ control, now, disabled = false }: { control: OwnerMemoryControl; now: number; disabled?: boolean }) {
  if (control.availability === "pending" || control.availability === "absent") return null;
  return <MemoryEditor memory={control.memory} editable={control.editable && !control.busy} label="Your memory" caption={OWNER_MEMORY_CAPTION} save={control.set} now={now} disabled={disabled} />;
}

export type ThreadFlushOutcome = { repositoryId: string; result: { messages: number; freed: number } | "busy" | "failed" };

const LIMIT_OPTIONS = THREAD_LIMIT_MEGABYTES.map((megabytes) => ({ value: megabytes, label: megabytes === 0 ? "Never" : `${megabytes} MB` }));
const MEGABYTE = 1024 * 1024;
// The share of the limit at which a bar turns coral: a thread this full is flushed soon.
const NEAR_LIMIT = 0.8;

const spaceCaption = (total: number, limit: number) => limit === 0
  ? `${threadSize(total)} in all. Nothing is removed unless you flush it.`
  : `${threadSize(total)} in all. At ${limit} MB, Aril removes a conversation's oldest messages and their images, down to 75% of that. Its summary and newest message stay.`;

/** One bar: a thread's size against the limit, with a tick at the limit. Without a limit the bar is scaled to the largest thread and has no tick. */
function SpaceBar({ name, bytes, limit, scale }: { name: string; bytes: number; limit: number; scale: number }) {
  const ratio = Math.min(1, scale > 0 ? bytes / scale : 0);
  const width = Math.max(ratio * 100, bytes > 0 ? 1 : 0);
  return <div className="arilSpaceBar" role="meter" aria-label={`${name} conversation size`} aria-valuemin={0} aria-valuemax={scale} aria-valuenow={Math.min(bytes, scale)}
    aria-valuetext={limit > 0 ? `${threadSize(bytes)} of ${limit} MB` : threadSize(bytes)}>
    <span className={`arilSpaceFill${limit > 0 && ratio >= NEAR_LIMIT ? " isNear" : ""}`} style={{ width: `${width.toFixed(1)}%` }} />
    {limit > 0 && <span className="arilSpaceTick" aria-hidden="true" />}
  </div>;
}

/**
 * The Conversation space card: how much space each repository's thread takes against the limit that flushes it by itself, and the owner's own
 * flush. "Flush oldest at" is one setting of the desktop app. The flush asks in the card first and says what it removes. Only the desktop app
 * draws the card. `names` maps a repository ID to the name the owner knows it by; a thread with no name or no content is not listed.
 */
export function ConversationSpaceCard({ control, names, disabled = false, initialAsking = null, initialOutcome = null }: {
  control: ThreadSpaceControl;
  names: ReadonlyMap<string, string>;
  /** The page's Aril-is-off state: the limit and every flush are disabled, and a flush question that was open is closed. */
  disabled?: boolean;
  /** A static frame opens with this repository's question or this outcome showing. */
  initialAsking?: string | null;
  initialOutcome?: ThreadFlushOutcome | null;
}) {
  const [asking, setAsking] = useState<string | null>(initialAsking);
  const [outcome, setOutcome] = useState<ThreadFlushOutcome | null>(initialOutcome);
  const [limitFailed, setLimitFailed] = useState(false);
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) { setWasDisabled(disabled); if (disabled) setAsking(null); }
  if (control.repositories === null || control.limit === null) return null;
  const limit = control.limit;
  const listed = control.repositories.filter((thread) => names.has(thread.repositoryId) && (thread.bytes > 0 || thread.messages > 0))
    .sort((left, right) => right.bytes - left.bytes || (names.get(left.repositoryId) ?? "").localeCompare(names.get(right.repositoryId) ?? ""));
  const total = listed.reduce((sum, thread) => sum + thread.bytes, 0);
  const scale = limit > 0 ? limit * MEGABYTE : Math.max(1, ...listed.map((thread) => thread.bytes)) * 1.25;
  const flush = async (repositoryId: string) => {
    setAsking(null);
    const answer = await control.flush(repositoryId);
    setOutcome({ repositoryId, result: "flushed" in answer ? answer.flushed : answer.error === "busy" ? "busy" : "failed" });
  };
  return <ArilCard title="Conversation space" aside={<label className="arilCardAside">Flush oldest at
    <CommandSelect aria-label="Flush oldest at" options={LIMIT_OPTIONS} value={limit} disabled={disabled} onChange={(next) => { setLimitFailed(false); void control.setLimit(next).then((kept) => setLimitFailed(!kept)); }} />
  </label>}>
    <p className="arilCardCaption">{spaceCaption(total, limit)}</p>
    {limitFailed && <p className="newTaskError arilCardAlert" role="alert">The limit could not be changed. Try again.</p>}
    {listed.length === 0 && <p className="arilCardNote">No conversations yet.</p>}
    {listed.map((thread) => {
      const name = names.get(thread.repositoryId) ?? "";
      const result = outcome?.repositoryId === thread.repositoryId ? outcome.result : null;
      const flushable = thread.messages >= 2;
      return <div className="arilSpaceRow" key={thread.repositoryId}>
        <span className="arilSpaceName">{name}</span>
        <SpaceBar name={name} bytes={thread.bytes} limit={limit} scale={scale} />
        <span className="arilSpaceSize">{threadSize(thread.bytes)} <span>{`· ${thread.messages} ${thread.messages === 1 ? "message" : "messages"}`}</span></span>
        <button type="button" className="commandQuietAction arilSpaceAction" aria-label={flushable ? `Flush oldest messages of ${name}` : `${name}: nothing to flush`} disabled={disabled || !flushable || control.flushing !== null}
          onClick={() => { setOutcome(null); setAsking(thread.repositoryId); }}>{flushable ? "Flush oldest" : "Nothing to flush"}</button>
        {asking === thread.repositoryId && flushable && !disabled && <div className="arilSpaceAsk">
          <span>{`Remove the oldest ${Math.floor(thread.messages / 2)} of ${thread.messages} messages and their images?`}</span>
          <button type="button" className="commandSecondaryAction" disabled={control.flushing !== null} onClick={() => void flush(thread.repositoryId)}>Flush messages</button>
          <button type="button" className="commandQuietAction" onClick={() => setAsking(null)}>Cancel</button>
        </div>}
        {result === "busy" && <p className="arilSpaceResult" role="status">Aril is answering in this repository. Try again when it is done.</p>}
        {result === "failed" && <p className="newTaskError arilSpaceResult" role="alert">The messages could not be flushed. Try again.</p>}
        {result !== null && result !== "busy" && result !== "failed" && <p className="arilSpaceResult" role="status">{`Removed ${result.messages} ${result.messages === 1 ? "message" : "messages"} and freed ${threadSize(result.freed)}.`}</p>}
      </div>;
    })}
  </ArilCard>;
}

/**
 * Effort routing as one compact row: the title, whether a Jev key is set, the caption, and the buttons. Replace key (or Add key) opens the key
 * field under the row. The key goes to desktop main once and the field is emptied when it was saved; the renderer never receives the key back,
 * only whether one is set. Only the desktop app draws the row.
 */
export function EffortRoutingRow({ jev, disabled = false, initialEditing = false, initialFailure = null }: { jev: JevKeyControl; disabled?: boolean; initialEditing?: boolean; initialFailure?: "save" | "remove" | null }) {
  const [editing, setEditing] = useState(initialEditing);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"save" | "remove" | null>(initialFailure);
  const fieldId = useId();
  // Turning Aril off closes the key field and empties it.
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) { setWasDisabled(disabled); if (disabled) { setEditing(false); setKey(""); setFailed(null); } }
  const stateWord = jev.state === "set" ? "Jev key set" : jev.state === "unset" ? "No Jev key" : jev.state === "unavailable" ? "This computer cannot store the key safely" : "Checking…";
  const change = async (which: "save" | "remove") => {
    if (busy || disabled) return;
    const secret = key;
    setBusy(true);
    setFailed(null);
    try {
      if (await (which === "save" ? jev.save(secret) : jev.remove())) { setKey(""); setEditing(false); } else setFailed(which);
    } catch { setFailed(which); } finally { setBusy(false); }
  };
  const valid = JEV_KEY_PATTERN.test(key);
  return <section className="arilCard arilEffort" aria-labelledby={`${fieldId}-title`}>
    <div className="arilEffortRow">
      <div className="arilEffortText">
        <div className="arilEffortTitle"><h3 id={`${fieldId}-title`}>Effort routing</h3><span className={jev.state === "set" ? "isSet" : undefined}>{stateWord}</span></div>
        <p className="arilCardCaption">Jev may lower the effort you chose for simple replies, never raise it. It sees your message and the end of Aril&apos;s last answer.</p>
      </div>
      {jev.state !== "unavailable" && !editing && <button type="button" className="commandSecondaryAction" disabled={disabled} onClick={() => setEditing(true)}>{jev.state === "set" ? "Replace key" : "Add key"}</button>}
      {jev.state === "set" && !editing && <button type="button" className="commandQuietAction" aria-label="Remove Jev key" disabled={busy || disabled} onClick={() => void change("remove")}>Remove</button>}
    </div>
    {editing && !disabled && <div className="arilEffortKey">
      <label htmlFor={fieldId}>Jev key</label>
      <input id={fieldId} className="taskOwnInput" type="password" autoComplete="off" spellCheck={false} maxLength={512} value={key} disabled={busy} aria-invalid={key !== "" && !valid} onChange={(event) => setKey(event.currentTarget.value)} />
      <button type="button" className="commandSecondaryAction" disabled={busy || !valid} onClick={() => void change("save")}>Save key</button>
      <button type="button" className="commandQuietAction" disabled={busy} onClick={() => { setEditing(false); setKey(""); setFailed(null); }}>Cancel</button>
    </div>}
    {key !== "" && !valid && <p className="newTaskError arilCardAlert">Use 8 to 512 characters without spaces.</p>}
    {failed && <p className="newTaskError arilCardAlert" role="alert">{failed === "save" ? "The key could not be saved. Try again." : "The key could not be removed. Try again."}</p>}
  </section>;
}
