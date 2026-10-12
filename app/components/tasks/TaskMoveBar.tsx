"use client";

import { useState } from "react";
import type { KeyboardEvent } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import { CommandSelect } from "../command-center/CommandSelect";
import type { CardMoveKind } from "./task-board-model";
import type { BoardStepChoice } from "./task-queue-model";

const KINDS: readonly CardMoveKind[] = ["up", "down", "left", "right"];
const PHRASES: Record<CardMoveKind, string> = { up: "up", down: "down", left: "to the previous column", right: "to the next column" };

export type CardMoves = Record<CardMoveKind, boolean>;
/** The step choices of a queued card that belongs to a feature. */
export type CardStepMove = { choices: BoardStepChoice[]; onMove(step: number): void };

export function TaskMoveBar({ id, available, onMove, step }: { id: string; available: CardMoves; onMove(kind: CardMoveKind): void; step?: CardStepMove }) {
  const enabled = KINDS.filter((kind) => available[kind]);
  const [current, setCurrent] = useState<CardMoveKind | null>(null);
  const stop = current && available[current] ? current : enabled[0];

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    // The step select handles its own keys, and every key while its list is open.
    if (event.defaultPrevented || (event.target instanceof Element && event.target.getAttribute("aria-expanded") === "true")) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (index < 0) return;
    const target = event.key === "ArrowRight" || event.key === "ArrowDown" ? buttons[(index + 1) % buttons.length]
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? buttons[(index - 1 + buttons.length) % buttons.length]
        : event.key === "Home" ? buttons[0] : event.key === "End" ? buttons[buttons.length - 1] : null;
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  return <div className="taskCardMoves" role="toolbar" aria-label={`Move ${id}`} onKeyDown={navigate}>
    {KINDS.map((kind) => {
      const label = `Move ${id} ${PHRASES[kind]}`;
      return <button key={kind} type="button" className="commandIconAction taskMove" data-move={kind} aria-label={label} title={label}
        disabled={!available[kind]} tabIndex={kind === stop ? 0 : -1} onFocus={() => setCurrent(kind)} onClick={() => onMove(kind)}>
        <CommandIcon name="arrow" />
      </button>;
    })}
    {step && step.choices.length > 0 && <CommandSelect className="taskMoveStep" aria-label={`Move ${id} to step`} placeholder="Move to step…" value={null}
      options={step.choices.map((choice) => ({ value: String(choice.step), label: choice.label, disabled: choice.disabled }))} onChange={(value) => step.onMove(Number(value))} />}
  </div>;
}
