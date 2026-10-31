"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { TaskBoard } from "../../shared/task-contract";
import { useArilSwitch, useOwnerMemory, useThreadSpace } from "../aril-control-client";
import { useRepositoryInventory } from "../repository-inventory-client";
import { useTasks } from "../tasks-store";
import { useJevKey } from "../components/tasks/jev-key-desktop";
import { sendTaskAction, useTaskEditAvailability } from "../components/tasks/task-desktop";
import { timeOfDay } from "../components/tasks/task-schedule";
import { ArilMemoryCard, ArilOffNotice, ArilSwitchCard, ConversationSpaceCard, EffortRoutingNote, EffortRoutingRow, OwnerMemoryPane, repositoryMemoryCaption, type MemoryTab } from "./ArilGlobalSettings";
import { MemoryEditor } from "./MemoryEditor";

// The section keeps the controls of Aril itself: the switch, the memory (yours, then each repository's), the conversation space, and the effort
// routing. It has no per-repository settings card: a grant's own sections are gone, and the reviewer choice moves to an agreement's Review action
// in phase 5 of the Aril plan. The stored reviewer values and the grant runtime are untouched. Where a grant is still running, one line shows
// when it ends and offers Stop grant.

const GRANT_REPOSITORIES = 16;
const FAILURES = { grant: "The grant could not be stopped. Try again." };
type Aril = NonNullable<TaskBoard["aril"]>;

const grantTime = (at: number) => timeOfDay(new Date(at).toISOString());

/** When an active grant ends, and Stop grant. Aril off means the grant does nothing, and the line says so. Nothing is drawn for a grant that is not active. */
export function GrantLine({ name, grant, arilOn, editable, busy = false, failed = false, onStop }: {
  name: string; grant: NonNullable<Aril["grant"]> | null | undefined; arilOn: boolean | null; editable: boolean; busy?: boolean; failed?: boolean; onStop(): void;
}) {
  if (!grant?.active) return null;
  return <div className="arilGrantLine">
    <span>{`A grant in ${name} is active until `}<span className="arilGrantTime">{grantTime(grant.endsAt)}</span>{arilOn === false ? ". Aril is off, so it does nothing." : "."}</span>
    {editable && <button type="button" className="commandSecondaryAction" aria-label={`Stop grant in ${name}`} disabled={busy} onClick={onStop}>Stop grant</button>}
    {failed && <span className="newTaskError" role="alert">{FAILURES.grant}</span>}
  </div>;
}

function RepositoryGrantLine({ repositoryId, name, arilOn }: { repositoryId: string; name: string; arilOn: boolean | null }) {
  const access = useTaskEditAvailability();
  const { board, refresh } = useTasks(repositoryId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const stop = async () => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try {
      const result = await sendTaskAction(repositoryId, "grant_stop", {});
      if (result.ok) await refresh(); else setFailed(true);
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <GrantLine name={name} grant={board.aril?.grant} arilOn={arilOn} editable={access === "desktop" || access === "paired"} busy={busy} failed={failed} onStop={() => void stop()} />;
}

/**
 * One repository's memory: read from its board and saved through the fixed `aril_memory_set` action. A paired device edits it only while the
 * owner allows paired devices to change Aril's memory and settings, the one global permission of the switch card (`pairedOn`).
 */
function RepositoryMemoryPane({ repositoryId, name, now, disabled, pairedOn }: { repositoryId: string; name: string; now: number; disabled: boolean; pairedOn: boolean }) {
  const access = useTaskEditAvailability();
  const { board, refresh } = useTasks(repositoryId);
  if (access === "pending" || board.readiness === "loading") return <p className="arilCardNote" role="status">Reading memory…</p>;
  if (!board.aril) return <p className="arilCardNote">Memory is unavailable.</p>;
  const allowed = access === "desktop" || (access === "paired" && pairedOn);
  const save = async (text: string) => {
    const result = await sendTaskAction(repositoryId, "aril_memory_set", { text });
    if (result.ok) await refresh();
    return result.ok;
  };
  return <MemoryEditor memory={board.aril.memory} editable={allowed} label={`${name} memory`} caption={repositoryMemoryCaption(name)} save={save} now={now} disabled={disabled} />;
}

/**
 * The Aril section of Settings. The top card holds the switch. Under it come the memory (yours, then each repository's), the space each
 * conversation takes, and, in the desktop app, the effort routing. Memory opens at the repository the link names, else at yours.
 */
export function ArilSettingsSection({ initialRepositoryId = null }: { initialRepositoryId?: string | null }) {
  const headingId = useId();
  const { snapshot } = useRepositoryInventory();
  const access = useTaskEditAvailability();
  const jev = useJevKey(access === "desktop");
  const aril = useArilSwitch();
  const ownerMemory = useOwnerMemory();
  const space = useThreadSpace();
  const [tab, setTab] = useState<string | null>(null);
  // The footer of a memory counts from this moment; it is read again each minute and never while the page is drawn on a server.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const options = useMemo(() => snapshot.repositories.map((repository) => ({ value: repository.id, label: repository.displayName })), [snapshot.repositories]);
  const names = useMemo(() => new Map(options.map((option) => [option.value, option.label])), [options]);
  const known = (id: string | null) => id !== null && options.some((option) => option.value === id);
  const hasOwner = ownerMemory.availability === "desktop" || ownerMemory.availability === "paired" || ownerMemory.availability === "pending";
  const tabs: MemoryTab[] = [...(hasOwner ? [{ id: "owner", label: "You" }] : []), ...options.map((option) => ({ id: option.value, label: option.label }))];
  const activeTab = [tab, known(initialRepositoryId) ? initialRepositoryId : null, hasOwner ? "owner" : null, options[0]?.value ?? null].find((id) => id !== null && tabs.some((entry) => entry.id === id)) ?? null;
  // While Aril is off, everything under the switch card is read only and gray. Until the switch is answered it reads the same, so the page never
  // shows the cards editable and then takes that back; a plain browser has no switch and edits nothing anyway.
  const reachable = aril.availability !== "absent";
  const locked = reachable && aril.state?.on !== true;
  return <section className="arilSettings" aria-labelledby={headingId}>
    <ArilSwitchCard control={aril} headingId={headingId} />
    {options.slice(0, GRANT_REPOSITORIES).map((option) => <RepositoryGrantLine key={option.value} repositoryId={option.value} name={option.label} arilOn={aril.state?.on ?? null} />)}
    {aril.state?.on === false && <ArilOffNotice />}
    <div className={`arilBelow${locked ? " isLocked" : ""}`} aria-disabled={locked || undefined}>
      {activeTab !== null && <ArilMemoryCard tabs={tabs} tab={activeTab} onTab={setTab} disabled={locked}>
        {activeTab === "owner" ? <OwnerMemoryPane control={ownerMemory} now={now} disabled={locked} />
          : <RepositoryMemoryPane key={activeTab} repositoryId={activeTab} name={names.get(activeTab) ?? ""} now={now} disabled={locked} pairedOn={aril.state?.pairedOn === true} />}
      </ArilMemoryCard>}
      <ConversationSpaceCard control={space} names={names} disabled={locked} />
      {jev ? <EffortRoutingRow jev={jev} disabled={locked} /> : access === "paired" && <EffortRoutingNote />}
    </div>
  </section>;
}
