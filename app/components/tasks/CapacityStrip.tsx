"use client";

import type { TaskBoard, TaskProvider } from "../../../shared/task-contract";
import { PROVIDER_NAMES, usageReading } from "./task-gates-model";

const PROVIDERS: readonly TaskProvider[] = ["claude", "codex"];

/** Provider capacity above the Board (design contract D35-D39): the same readings the Start gates panel shows. Omitted without gates. */
export function CapacityStrip({ queue }: { queue: TaskBoard["queue"] }) {
  const gates = queue.gates;
  if (!gates) return null;
  return <section className="taskCapacityStrip" aria-label="Provider capacity">
    <span className="taskFilterEyebrow">Start gates</span>
    {PROVIDERS.map((provider) => <span key={provider} className="taskCapacityReading">
      <span className="taskCapacityLabel">{PROVIDER_NAMES[provider]}</span>{" "}
      <span className="taskCapacityValue">{usageReading(gates.usage[provider]) ?? "Unknown"}</span>
    </span>)}
    <span className="taskCapacityRule">A task starts only when its provider has capacity.</span>
  </section>;
}
