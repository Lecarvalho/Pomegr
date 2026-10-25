"use client";

import type { RefObject } from "react";
import type { ArilGrant, TaskBoard, TaskProvider } from "../../../shared/task-contract";
import { PROVIDER_NAMES, usageReading } from "./task-gates-model";
import { timeOfDay } from "./task-schedule";

const PROVIDERS: readonly TaskProvider[] = ["claude", "codex"];

/** `onOpenSettings` adds the Board's end of the strip: the threshold, the stop time and the action that opens Queue settings. `onOpenScorecard` adds Scorecard before it (desktop app only). */
export function CapacityStrip({ queue, grant, settingsRef, onOpenSettings, scorecardRef, onOpenScorecard, logRef, onOpenLog, arilRef, onOpenAril }: {
  queue: TaskBoard["queue"];
  grant?: ArilGrant | null;
  settingsRef?: RefObject<HTMLButtonElement | null>;
  onOpenSettings?(): void;
  scorecardRef?: RefObject<HTMLButtonElement | null>;
  onOpenScorecard?(): void;
  logRef?: RefObject<HTMLButtonElement | null>;
  onOpenLog?(): void;
  arilRef?: RefObject<HTMLButtonElement | null>;
  onOpenAril?(): void;
}) {
  const gates = queue.gates;
  if (!gates && !onOpenSettings) return null;
  const stop = timeOfDay(queue.schedule?.stopAfter ?? null);
  return <section className="taskCapacityStrip" aria-label="Provider capacity">
    {gates && <>
      <span className="taskFilterEyebrow">Start gates</span>
      {PROVIDERS.map((provider) => <span key={provider} className="taskCapacityReading">
        <span className="taskCapacityLabel">{PROVIDER_NAMES[provider]}</span>{" "}
        <span className="taskCapacityValue">{usageReading(gates.usage[provider]) ?? "Unknown"}</span>
      </span>)}
      <span className="taskCapacityRule">A task starts only when its provider has capacity.</span>
    </>}
    {onOpenSettings && <span className="taskCapacityEnd">
      {gates && <span className="taskCapacitySettings">
        Do not start above <span className="taskCapacityValue">{gates.threshold}%</span>
        {stop !== "" && <> · stops starting after <span className="taskCapacityValue">{stop}</span></>}
      </span>}
      {grant?.active && <span className="taskGrantActive">Aril grant until {timeOfDay(new Date(grant.endsAt).toISOString())}</span>}
      {onOpenAril && <button ref={arilRef} type="button" className="commandQuietAction taskQueueSettingsAction" aria-haspopup="dialog" onClick={onOpenAril}>Aril settings</button>}
      {onOpenLog && <button ref={logRef} type="button" className="commandQuietAction taskQueueSettingsAction" aria-haspopup="dialog" onClick={onOpenLog}>Log</button>}
      {onOpenScorecard && <button ref={scorecardRef} type="button" className="commandQuietAction taskQueueSettingsAction" aria-haspopup="dialog" onClick={onOpenScorecard}>Scorecard</button>}
      <button ref={settingsRef} type="button" className="commandQuietAction taskQueueSettingsAction" aria-haspopup="dialog" onClick={onOpenSettings}>Queue settings</button>
    </span>}
  </section>;
}
