"use client";

import type { RefObject } from "react";
import type { TaskBoard, TaskProvider } from "../../../shared/task-contract";
import { PROVIDER_NAMES, usageReading } from "./task-gates-model";
import { timeOfDay } from "./task-schedule";

const PROVIDERS: readonly TaskProvider[] = ["claude", "codex"];

/** `onOpenSettings` adds the Board's end of the strip: the threshold, the stop time and the action that opens Queue settings. */
export function CapacityStrip({ queue, settingsRef, onOpenSettings }: {
  queue: TaskBoard["queue"];
  settingsRef?: RefObject<HTMLButtonElement | null>;
  onOpenSettings?(): void;
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
      <button ref={settingsRef} type="button" className="commandQuietAction taskQueueSettingsAction" aria-haspopup="dialog" onClick={onOpenSettings}>Queue settings</button>
    </span>}
  </section>;
}
