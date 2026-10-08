"use client";

import { useState } from "react";
import type { KeyboardEvent } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import type { CardMoveKind } from "./task-board-model";

// The keyboard alternative to dragging a card: four Icon-role actions in one toolbar (one tab stop, arrow keys inside).
// The bar is drawn only while the card holds keyboard focus (or on a coarse pointer); it stays in the accessibility tree.

const KINDS: readonly CardMoveKind[] = ["up", "down", "left", "right"];
const PHRASES: Record<CardMoveKind, string> = { up: "up", down: "down", left: "to the previous column", right: "to the next column" };

export type CardMoves = Record<CardMoveKind, boolean>;

export function TaskMoveBar({ id, available, onMove }: { id: string; available: CardMoves; onMove(kind: CardMoveKind): void }) {
  const enabled = KINDS.filter((kind) => available[kind]);
  const [current, setCurrent] = useState<CardMoveKind | null>(null);
  // The one tab stop is the last button used, or the first that can move.
  const stop = current && available[current] ? current : enabled[0];

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
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
  </div>;
}
