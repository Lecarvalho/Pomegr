"use client";

import { useId, useState } from "react";
import type { ArilSwitchControl, OwnerMemoryControl, ThreadSpaceControl } from "../aril-control-client";
import { MemoryList } from "./MemoryList";
import { formatStorageBytes } from "./StorageSettings";
import { SettingRow } from "./SettingRow";

// The parts of Settings › Aril that belong to Aril itself and not to one repository: the On/Off switch, the owner's memory, and the space each
// thread takes. Each takes the control it shows, so the live section and the static design-system frames draw the same markup.

const SWITCH_ON = "Aril acts as you settled with it. Turning it off stops its actions at once; running sessions continue.";
const SWITCH_OFF = "Aril takes no action of its own. The chat still answers when you write.";

/** A thread's size in the unit that reads best: bytes, kilobytes, then the storage meter's megabytes and gigabytes. */
export function threadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return formatStorageBytes(bytes);
}

/** The On/Off switch at the top of the section, and, in the desktop app, whether a paired device may turn Aril on. */
export function ArilSwitchPanel({ control }: { control: ArilSwitchControl }) {
  const switchId = useId();
  const pairedId = useId();
  const { availability, state, busy, failed, canTurnOn } = control;
  if (availability === "pending") return null;
  if (availability === "absent") return <p className="arilSettingsNote">Turn Aril on or off in the desktop app or on a paired device.</p>;
  if (state === null) return <p className="arilSettingsNote" role="status">Reading Aril…</p>;
  return <>
    <div className="arilSettingsPanel">
      <SettingRow label="Aril" description={state.on ? SWITCH_ON : SWITCH_OFF} labelFor={switchId} descriptionId={`${switchId}-description`}>
        <span className="arilSwitchControl">
          <span className={`commandChip${state.on ? " positive" : ""}`}>{state.on ? "On" : "Off"}</span>
          <input id={switchId} type="checkbox" role="switch" aria-label="Aril" checked={state.on} disabled={busy || (!state.on && !canTurnOn)} aria-describedby={`${switchId}-description`}
            onChange={(event) => void control.setOn(event.currentTarget.checked)} />
        </span>
      </SettingRow>
      {availability === "desktop" && <SettingRow label="Paired devices" description="Let a paired device turn Aril on. A paired device can always turn it off." labelFor={pairedId}>
        <input id={pairedId} type="checkbox" role="switch" aria-label="Let a paired device turn Aril on" checked={state.pairedOn} disabled={busy} onChange={(event) => void control.setPairedOn(event.currentTarget.checked)} />
      </SettingRow>}
    </div>
    {!state.on && !canTurnOn && <p className="arilSettingsNote">Turning Aril on needs the desktop app.</p>}
    {failed && <p className="arilSettingsNote newTaskError" role="alert">Aril could not be changed. Try again.</p>}
  </>;
}

/** The owner's memory: a paired device reads it, and only the desktop app edits it. Aril reads these lines in every repository and cannot change them. */
export function OwnerMemorySection({ control }: { control: OwnerMemoryControl }) {
  const [failed, setFailed] = useState(false);
  if (control.availability === "pending" || control.availability === "absent") return null;
  const run = async (change: Promise<boolean>) => {
    const accepted = await change;
    setFailed(!accepted);
    return accepted;
  };
  return <div className="taskQueueSettings arilSettingsBody">
    <section className="taskGatesPanel taskSchedulePanel">
      <h3 className="taskGatesHeading">Your memory</h3>
      {control.entries === null ? <p className="taskGatesCaption" role="status">Reading your memory…</p> : <MemoryList entries={control.entries} editable={control.editable} busy={control.busy} scope="your "
        caption="How you like to work with Aril in every repository. Aril reads these lines and cannot change them; you edit them here."
        onAdd={(text) => run(control.add(text))} onUpdate={(id, text) => run(control.update(id, text))} onRemove={(id) => run(control.remove(id))} />}
      {failed && <p className="newTaskError" role="alert">Memory could not be saved. Try again.</p>}
    </section>
  </div>;
}

export type ThreadFlushOutcome = { repositoryId: string; result: { messages: number; freed: number } | "busy" | "failed" };

/**
 * What each repository's thread takes on disk, and the flush that gives space back. The flush asks in the panel first, and says what it
 * removes. Only the desktop app draws it. `names` maps a repository ID to the name the owner knows it by; a thread with no name is not listed.
 */
export function ThreadSpaceSection({ control, names, initialAsking = null, initialOutcome = null }: {
  control: ThreadSpaceControl;
  names: ReadonlyMap<string, string>;
  /** A static frame opens with this repository's question or this outcome showing. */
  initialAsking?: string | null;
  initialOutcome?: ThreadFlushOutcome | null;
}) {
  const [asking, setAsking] = useState<string | null>(initialAsking);
  const [outcome, setOutcome] = useState<ThreadFlushOutcome | null>(initialOutcome);
  if (control.repositories === null) return null;
  const listed = control.repositories.filter((thread) => names.has(thread.repositoryId) && (thread.bytes > 0 || thread.messages > 0));
  const flush = async (repositoryId: string) => {
    setAsking(null);
    const answer = await control.flush(repositoryId);
    setOutcome({ repositoryId, result: "flushed" in answer ? answer.flushed : answer.error === "busy" ? "busy" : "failed" });
  };
  return <div className="taskQueueSettings arilSettingsBody">
    <section className="taskGatesPanel taskSchedulePanel">
      <h3 className="taskGatesHeading">Thread space</h3>
      <p className="taskGatesCaption">What each repository&apos;s conversation with Aril takes on disk. Flushing removes the oldest half of its messages and their images. Aril keeps its summary and the newest messages.</p>
      {listed.length === 0 && <p className="taskGatesCaption">No conversations yet.</p>}
      {listed.map((thread) => {
        const name = names.get(thread.repositoryId) ?? "";
        const result = outcome?.repositoryId === thread.repositoryId ? outcome.result : null;
        return <div className="taskGateField" key={thread.repositoryId}>
          <span className="taskGateReadOnly"><span className="commandMonoValue">{name}</span>{` · ${threadSize(thread.bytes)} · ${thread.messages} ${thread.messages === 1 ? "message" : "messages"}`}</span>
          {thread.messages >= 2 && <div className="taskHeadActions">
            {asking === thread.repositoryId ? <><span>{`Remove the oldest ${Math.floor(thread.messages / 2)} of ${thread.messages} messages and their images?`}</span>
              <button type="button" className="commandSecondaryAction" disabled={control.flushing !== null} onClick={() => void flush(thread.repositoryId)}>Flush messages</button>
              <button type="button" className="commandQuietAction" onClick={() => setAsking(null)}>Cancel</button></>
              : <button type="button" className="commandQuietAction" aria-label={`Flush oldest messages of ${name}`} disabled={control.flushing !== null} onClick={() => { setOutcome(null); setAsking(thread.repositoryId); }}>Flush oldest messages</button>}
          </div>}
          {result === "busy" && <p className="taskGatesCaption" role="status">Aril is answering in this repository. Try again when it is done.</p>}
          {result === "failed" && <p className="newTaskError" role="alert">The messages could not be flushed. Try again.</p>}
          {result !== null && result !== "busy" && result !== "failed" && <p className="taskGatesCaption" role="status">{`Removed ${result.messages} ${result.messages === 1 ? "message" : "messages"} and freed ${threadSize(result.freed)}.`}</p>}
        </div>;
      })}
    </section>
  </div>;
}
