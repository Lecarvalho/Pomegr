"use client";

import type { ReactNode } from "react";
import type { ArilSwitchControl, OwnerMemoryControl, ThreadSpaceControl } from "../../aril-control-client";
import { ArilSwitchPanel, OwnerMemorySection, ThreadSpaceSection } from "../../settings/ArilGlobalSettings";
import { Sample } from "./DesignSystemKit";

// Aril's own controls in Settings, from static data: the switch, the owner's memory, and the space each thread takes. Nothing here reads the
// clock or asks the desktop, so a render on the server and the hydration after it agree.

const never = async () => false;
const SWITCH: ArilSwitchControl = { availability: "desktop", state: { on: false, pairedOn: false }, busy: false, failed: false, canTurnOn: true, setOn: never, setPairedOn: never };
const memory = (count: number, size = 24): OwnerMemoryControl["entries"] => Array.from({ length: count }, (_, id) => ({ id: id + 1, text: `${id + 1}. Keep changes focused and small.`.padEnd(size, "."), createdAt: id, updatedAt: id }));
const MEMORY: OwnerMemoryControl = { availability: "desktop", entries: memory(2), editable: true, busy: false, add: never, update: never, remove: never };
const SPACE: ThreadSpaceControl["repositories"] = [
  { repositoryId: "repo-0123456789abcdef01234567", bytes: 1.5 * 1024 * 1024, messages: 40 },
  { repositoryId: "repo-fedcba9876543210fedcba98", bytes: 36 * 1024, messages: 6 },
  { repositoryId: "repo-00000000000000000000aaaa", bytes: 2048, messages: 1 },
];
const NAMES = new Map([["repo-0123456789abcdef01234567", "pomegr"], ["repo-fedcba9876543210fedcba98", "clapline"], ["repo-00000000000000000000aaaa", "notes"]]);
const SPACE_CONTROL: ThreadSpaceControl = { repositories: SPACE, flushing: null, flush: async () => ({ error: "failed" }) };

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame arilSettings">{children}</div>;
}

/** The parts of Settings › Aril that belong to Aril itself: the On/Off switch, the owner's memory, and the thread space. */
export function ArilControlSamples() {
  return <div className="designSystemGrid">
    <Sample label="Aril switch, Off" note="The first panel of the section: a state chip (neutral for Off) and a switch. The desktop app also shows the paired-device permission.">
      <Frame><ArilSwitchPanel control={SWITCH} /></Frame>
    </Sample>
    <Sample label="Aril switch, On" note="On reads in the positive tone. Turning it off needs no confirmation and stops Aril's actions at once; running sessions continue.">
      <Frame><ArilSwitchPanel control={{ ...SWITCH, state: { on: true, pairedOn: true } }} /></Frame>
    </Sample>
    <Sample label="Aril switch, paired device" note="A paired device can always turn Aril off, and turn it on only when the desktop app allowed it. Otherwise the switch is unavailable and says where to turn Aril on.">
      <Frame><ArilSwitchPanel control={{ ...SWITCH, availability: "paired", canTurnOn: false }} /></Frame>
    </Sample>
    <Sample label="Aril switch, change failed" note="The state it knew stays, and the failure is a fixed line.">
      <Frame><ArilSwitchPanel control={{ ...SWITCH, failed: true }} /></Frame>
    </Sample>
    <Sample label="Aril switch, not reachable" note="A browser that is neither the desktop app nor a paired device only says where the switch is.">
      <Frame><ArilSwitchPanel control={{ ...SWITCH, availability: "absent", state: null }} /></Frame>
    </Sample>
    <Sample label="Your memory, desktop app" note="The same list a repository's memory uses, with its own field names. Aril reads these lines in every repository and cannot change them.">
      <Frame><OwnerMemorySection control={MEMORY} /></Frame>
    </Sample>
    <Sample label="Your memory, over the limit" note="Aril reads the newest lines that fit 6,000 characters. The caption counts the older lines that do not fit.">
      <Frame><OwnerMemorySection control={{ ...MEMORY, entries: memory(25, 300) }} /></Frame>
    </Sample>
    <Sample label="Your memory, paired device" note="A paired device reads the lines and has no field or action.">
      <Frame><OwnerMemorySection control={{ ...MEMORY, availability: "paired", editable: false }} /></Frame>
    </Sample>
    <Sample label="Thread space" note="Each repository's conversation with its size on disk and its messages. A thread of one message has no flush.">
      <Frame><ThreadSpaceSection control={SPACE_CONTROL} names={NAMES} /></Frame>
    </Sample>
    <Sample label="Thread space, flush question" note="The question is in the panel, says what it removes, and nothing changes until Flush messages.">
      <Frame><ThreadSpaceSection control={SPACE_CONTROL} names={NAMES} initialAsking="repo-0123456789abcdef01234567" /></Frame>
    </Sample>
    <Sample label="Thread space, flushed" note="One quiet status line says what was removed and the space it freed.">
      <Frame><ThreadSpaceSection control={SPACE_CONTROL} names={NAMES} initialOutcome={{ repositoryId: "repo-0123456789abcdef01234567", result: { messages: 20, freed: 700 * 1024 } }} /></Frame>
    </Sample>
    <Sample label="Thread space, not flushed" note="While Aril answers in that repository, or when the flush failed, one fixed line says so.">
      <Frame><ThreadSpaceSection control={SPACE_CONTROL} names={NAMES} initialOutcome={{ repositoryId: "repo-fedcba9876543210fedcba98", result: "busy" }} /></Frame>
    </Sample>
  </div>;
}

