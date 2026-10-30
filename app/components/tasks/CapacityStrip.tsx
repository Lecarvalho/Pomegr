"use client";

import Link from "next/link";
import type { RefObject } from "react";
import type { ArilGrant, TaskBoard, TaskProvider } from "../../../shared/task-contract";
import { PROVIDER_NAMES, usageReading } from "./task-gates-model";
import { timeOfDay } from "./task-schedule";

const PROVIDERS: readonly TaskProvider[] = ["claude", "codex"];

/** Aril's settings are a section of Settings, with the board's repository chosen. */
export const arilSettingsHref = (repositoryId: string) => `/settings?${new URLSearchParams({ section: "aril", repository: repositoryId })}`;

/** `onOpenSettings` adds the Board's end of the strip: the threshold, the stop time and the action that opens Queue settings. `onOpenScorecard` adds Scorecard before it (desktop app only). `arilHref` adds the link to the board's Aril settings in Settings, before Log. */
export function CapacityStrip({ queue, grant, settingsRef, onOpenSettings, scorecardRef, onOpenScorecard, logRef, onOpenLog, arilHref }: {
  queue: TaskBoard["queue"];
  grant?: ArilGrant | null;
  settingsRef?: RefObject<HTMLButtonElement | null>;
  onOpenSettings?(): void;
  scorecardRef?: RefObject<HTMLButtonElement | null>;
  onOpenScorecard?(): void;
  logRef?: RefObject<HTMLButtonElement | null>;
  onOpenLog?(): void;
  arilHref?: string;
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
      {arilHref && <Link className="commandQuietAction taskQueueSettingsAction" href={arilHref}>Aril settings</Link>}
      {onOpenLog && <button ref={logRef} type="button" className="commandQuietAction taskQueueSettingsAction" aria-haspopup="dialog" onClick={onOpenLog}>Log</button>}
      {onOpenScorecard && <button ref={scorecardRef} type="button" className="commandQuietAction taskQueueSettingsAction" aria-haspopup="dialog" onClick={onOpenScorecard}>Scorecard</button>}
      <button ref={settingsRef} type="button" className="commandQuietAction taskQueueSettingsAction" aria-haspopup="dialog" onClick={onOpenSettings}>Queue settings</button>
    </span>}
  </section>;
}
