"use client";

import { useState } from "react";
import type { KeyboardEvent } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import type { CardMoveKind } from "./task-board-model";

const KINDS: readonly CardMoveKind[] = ["up", "down", "left", "right"];
const PHRASES: Record<CardMoveKind, string> = { up: "up", down: "down", left: "to the previous column", right: "to the next column" };

export type CardMoves = Record<CardMoveKind, boolean>;
/** What a waiting card of a parallel group can do beside moving: leave the group. */
export type CardGroupMove = { onLeave(): void };

export function TaskMoveBar({ id, available, onMove, group, onAfter }: { id: string; available: CardMoves; onMove(kind: CardMoveKind): void; group?: CardGroupMove;
  /** Opens the task modal at its Runs after field. */
  onAfter?(opener: HTMLElement): void }) {
  const enabled = KINDS.filter((kind) => available[kind]);
  const [current, setCurrent] = useState<CardMoveKind | null>(null);
  const stop = current && available[current] ? current : enabled[0];

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
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
    {onAfter && <button type="button" className="commandQuietAction taskMoveLeave taskMoveAfter" aria-haspopup="dialog" aria-label={`Choose what ${id} runs after`} tabIndex={-1}
      onClick={(event) => onAfter(event.currentTarget)}>Runs after…</button>}
    {group && <button type="button" className="commandQuietAction taskMoveLeave" data-group-leave="" aria-label={`Take ${id} out of its parallel group`} tabIndex={-1} onClick={group.onLeave}>Take out of group</button>}
  </div>;
}
