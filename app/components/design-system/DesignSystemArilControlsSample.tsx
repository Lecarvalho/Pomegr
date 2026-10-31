"use client";

import { useId, useState, type ReactNode } from "react";
import type { ArilSwitchControl, OwnerMemoryControl, ThreadSpaceControl } from "../../aril-control-client";
import type { JevKeyControl } from "../tasks/jev-key-desktop";
import { CommandSwitch } from "../command-center/CommandSwitch";
import { ArilMemoryCard, ArilOffNotice, ArilSwitchCard, ConversationSpaceCard, EffortRoutingNote, EffortRoutingRow, OWNER_MEMORY_CAPTION, repositoryMemoryCaption } from "../../settings/ArilGlobalSettings";
import { MemoryEditor, type MemoryView } from "../../settings/MemoryEditor";
import { Sample } from "./DesignSystemKit";

// Aril's own cards in Settings, from static data: the switch, the memory, the conversation space, and the effort routing. Nothing here reads the
// clock or asks the desktop, so a render on the server and the hydration after it agree.

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);
const never = async () => false;
const SWITCH: ArilSwitchControl = { availability: "desktop", state: { on: false, pairedOn: false }, busy: false, failed: false, canTurnOn: true, setOn: never, setPairedOn: never };
const YOURS: MemoryView = {
  text: "- Reply in English or Portuguese, matching what I wrote.\n- Keep messages short. Ask with buttons when there are choices.\n- I merge pull requests myself.\n- Never print a key or a token, even partly.",
  previous: "- Reply in English or Portuguese, matching what I wrote.\n- Keep messages short. Ask with buttons when there are choices.\n- I merge pull requests myself.",
  updatedAt: NOW - 2 * HOUR, updatedBy: "aril",
};
const POMEGR: MemoryView = { text: "- Docs in English. One owner page per subject.\n- A phase is checked only after I accept it in the desktop app.", previous: null, updatedAt: NOW - 3 * 24 * HOUR, updatedBy: "owner" };
const TABS = [{ id: "owner", label: "You" }, { id: "pomegr", label: "pomegr" }, { id: "clapline", label: "clapline" }];
const MEMORY: OwnerMemoryControl = { availability: "desktop", memory: YOURS, editable: true, busy: false, set: never };
const SPACE: ThreadSpaceControl["repositories"] = [
  { repositoryId: "repo-0123456789abcdef01234567", bytes: 4.3 * 1024 * 1024, messages: 401 },
  { repositoryId: "repo-fedcba9876543210fedcba98", bytes: 1.9 * 1024 * 1024, messages: 155 },
  { repositoryId: "repo-00000000000000000000aaaa", bytes: 2048, messages: 2 },
  { repositoryId: "repo-00000000000000000000bbbb", bytes: 900, messages: 1 },
];
const NAMES = new Map([["repo-0123456789abcdef01234567", "pomegr"], ["repo-fedcba9876543210fedcba98", "clapline"], ["repo-00000000000000000000aaaa", "notes"], ["repo-00000000000000000000bbbb", "scratch"]]);
const SPACE_CONTROL: ThreadSpaceControl = { repositories: SPACE, limit: 5, flushing: null, flush: async () => ({ error: "failed" }), setLimit: never };
const JEV: JevKeyControl = { state: "set", save: never, remove: never };

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame arilSettings">{children}</div>;
}

function Hero({ control }: { control: ArilSwitchControl }) {
  return <Frame><ArilSwitchCard control={control} headingId={useId()} /></Frame>;
}

function MemoryFrame({ tab, children }: { tab: string; children: ReactNode }) {
  return <Frame><ArilMemoryCard tabs={TABS} tab={tab} onTab={() => undefined}>{children}</ArilMemoryCard></Frame>;
}

/** The page while Aril is off: the switch card stays active, a notice follows, and everything under it is gray, dimmed, and read only. */
function OffPage() {
  const headingId = useId();
  return <Frame>
    <ArilSwitchCard control={SWITCH} headingId={headingId} />
    <ArilOffNotice />
    <div className="arilBelow isLocked" aria-disabled="true">
      <ArilMemoryCard tabs={TABS} tab="owner" onTab={() => undefined} disabled>
        <MemoryEditor memory={YOURS} editable disabled label="Your memory" caption={OWNER_MEMORY_CAPTION} save={MEMORY.set} now={NOW} />
      </ArilMemoryCard>
      <ConversationSpaceCard control={SPACE_CONTROL} names={NAMES} disabled />
      <EffortRoutingRow jev={JEV} disabled />
    </div>
  </Frame>;
}

/** The shared switch, in each of its states. A tap acts at once. */
function SwitchStates() {
  const [on, setOn] = useState(true);
  return <div className="designSystemSwitches">
    <CommandSwitch aria-label="Switch, interactive" checked={on} onChange={setOn} />
    <CommandSwitch aria-label="Switch, off" checked={false} onChange={() => undefined} />
    <CommandSwitch aria-label="Switch, on" checked onChange={() => undefined} />
    <CommandSwitch small aria-label="Small switch, off" checked={false} onChange={() => undefined} />
    <CommandSwitch small aria-label="Small switch, on" checked onChange={() => undefined} />
    <CommandSwitch aria-label="Switch, unavailable" checked disabled onChange={() => undefined} />
  </div>;
}

/** The cards of Settings › Aril that belong to Aril itself: the switch, the memory, the conversation space, and the effort routing. */
export function ArilControlSamples() {
  return <div className="designSystemGrid designSystemArilGrid">
    <Sample label="Switch" note="The shared switch: a pill track and a round thumb that slides over 220ms. Green when on, neutral when off. It acts at once and never asks. Small beside a main one.">
      <SwitchStates />
    </Sample>
    <Sample label="Aril card, Off" note="The mark, the page heading with Aril's state, one line, and the switch on the right. The desktop app adds the paired-device permission under it.">
      <Hero control={SWITCH} />
    </Sample>
    <Sample label="Aril off, everything below read only" note="With Aril off the switch card and its paired-device row stay active. A neutral notice with a lock follows, and everything under it is dimmed, gray, and read only: its controls are disabled and the wrapper is aria-disabled. Turning Aril off closes any open edit.">
      <OffPage />
    </Sample>
    <Sample label="Aril card, On" note="On reads in green, with a soft glow on the card and a green mark. Turning it off needs no confirmation and stops Aril's actions at once; running sessions continue.">
      <Hero control={{ ...SWITCH, state: { on: true, pairedOn: true } }} />
    </Sample>
    <Sample label="Aril card, paired device" note="A paired device can always turn Aril off, and turn it on only when the desktop app allowed it. Otherwise the switch is unavailable and says where to turn Aril on.">
      <Hero control={{ ...SWITCH, availability: "paired", canTurnOn: false }} />
    </Sample>
    <Sample label="Aril card, change failed" note="The state it knew stays, and the failure is a fixed line.">
      <Hero control={{ ...SWITCH, failed: true }} />
    </Sample>
    <Sample label="Aril card, reading" note="Nothing of the state is drawn until the desktop has answered: no word, no glow, no switch.">
      <Hero control={{ ...SWITCH, state: null }} />
    </Sample>
    <Sample label="Aril card, not reachable" note="A browser that is neither the desktop app nor a paired device only says where the switch is.">
      <Hero control={{ ...SWITCH, availability: "absent", state: null }} />
    </Sample>
    <Sample label="Memory, you" note="Free text in a field with no focus ring, saved when the owner leaves it. The footer says who changed it last and when; Show change opens the text before the change.">
      <MemoryFrame tab="owner"><MemoryEditor memory={YOURS} editable label="Your memory" caption={OWNER_MEMORY_CAPTION} save={MEMORY.set} now={NOW} /></MemoryFrame>
    </Sample>
    <Sample label="Memory, change shown" note="Before and now, side by side. A line that differs from the other side carries a coral bar.">
      <MemoryFrame tab="owner"><MemoryEditor memory={YOURS} editable label="Your memory" caption={OWNER_MEMORY_CAPTION} save={MEMORY.set} now={NOW} initialShowChange /></MemoryFrame>
    </Sample>
    <Sample label="Memory, repository" note="One tab for each repository, after yours. The owner wrote this one.">
      <MemoryFrame tab="pomegr"><MemoryEditor memory={POMEGR} editable label="pomegr memory" caption={repositoryMemoryCaption("pomegr")} save={MEMORY.set} now={NOW} /></MemoryFrame>
    </Sample>
    <Sample label="Memory, read-only" note="A paired device reads the owner's memory, and a repository's memory when the desktop app allows it. The field is the same, with no edit.">
      <MemoryFrame tab="owner"><MemoryEditor memory={YOURS} editable={false} label="Your memory" caption={OWNER_MEMORY_CAPTION} save={MEMORY.set} now={NOW} /></MemoryFrame>
    </Sample>
    <Sample label="Memory, save failure" note="A refused save keeps what was typed and says so in a fixed line.">
      <MemoryFrame tab="owner"><MemoryEditor memory={YOURS} editable label="Your memory" caption={OWNER_MEMORY_CAPTION} save={MEMORY.set} now={NOW} initialFailed /></MemoryFrame>
    </Sample>
    <Sample label="Memory, reading" note="One status line until the memory has been read.">
      <MemoryFrame tab="owner"><MemoryEditor memory={null} editable label="Your memory" caption={OWNER_MEMORY_CAPTION} save={MEMORY.set} now={NOW} /></MemoryFrame>
    </Sample>
    <Sample label="Conversation space" note="Each thread's size against the limit that flushes it, with a tick at the limit. The fill turns coral from 80% of the limit. A thread of one message has nothing to flush.">
      <Frame><ConversationSpaceCard control={SPACE_CONTROL} names={NAMES} /></Frame>
    </Sample>
    <Sample label="Conversation space, never" note="With the limit on Never the bars are scaled to the largest thread, have no tick, and nothing is removed unless the owner flushes it.">
      <Frame><ConversationSpaceCard control={{ ...SPACE_CONTROL, limit: 0 }} names={NAMES} /></Frame>
    </Sample>
    <Sample label="Conversation space, flush question" note="The question is in the card, says what it removes, and nothing changes until Flush messages.">
      <Frame><ConversationSpaceCard control={SPACE_CONTROL} names={NAMES} initialAsking="repo-0123456789abcdef01234567" /></Frame>
    </Sample>
    <Sample label="Conversation space, flushed" note="One quiet status line says what was removed and the space it freed.">
      <Frame><ConversationSpaceCard control={SPACE_CONTROL} names={NAMES} initialOutcome={{ repositoryId: "repo-0123456789abcdef01234567", result: { messages: 200, freed: 1.5 * 1024 * 1024 } }} /></Frame>
    </Sample>
    <Sample label="Conversation space, not flushed" note="While Aril answers in that repository, or when the flush failed, one fixed line says so.">
      <Frame><ConversationSpaceCard control={SPACE_CONTROL} names={NAMES} initialOutcome={{ repositoryId: "repo-fedcba9876543210fedcba98", result: "busy" }} /></Frame>
    </Sample>
    <Sample label="Effort routing, key set" note="One compact row: the title, whether a Jev key is set, the caption, Replace key, and a quiet Remove.">
      <Frame><EffortRoutingRow jev={JEV} /></Frame>
    </Sample>
    <Sample label="Effort routing, no key" note="Without a key nothing changes. Add key opens the key field.">
      <Frame><EffortRoutingRow jev={{ ...JEV, state: "unset" }} /></Frame>
    </Sample>
    <Sample label="Effort routing, key field" note="The key goes to the desktop once and the field is emptied; the app never receives the key back.">
      <Frame><EffortRoutingRow jev={JEV} initialEditing initialFailure="save" /></Frame>
    </Sample>
    <Sample label="Effort routing, paired device" note="A paired device reads nothing and shows no state: the title, the caption, and one line that the key is changed in the desktop app.">
      <Frame><EffortRoutingNote /></Frame>
    </Sample>
  </div>;
}
