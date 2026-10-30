"use client";

import type { AriaAttributes } from "react";

type CommandSwitchProps = {
  checked: boolean;
  onChange(next: boolean): void;
  /** The 36px by 20px size, for a switch that sits in a quiet row beside the main one. */
  small?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
} & Pick<AriaAttributes, "aria-label" | "aria-labelledby" | "aria-describedby">;

/**
 * The shared switch: a `button` with `role="switch"` and `aria-checked`, a pill track and a round thumb that slides over 220ms. It acts at once,
 * so the owner never confirms it. Green when on and neutral when off; off is never a warning. A coarse pointer reaches 44px through a larger hit
 * area, not a larger track. The track and thumb are the one fully round shape of the application besides the chat's Send action.
 * `DESIGN.md` owns the contract and `/design-system` renders it.
 */
export function CommandSwitch({ checked, onChange, small = false, disabled = false, id, className = "", ...aria }: CommandSwitchProps) {
  return <button type="button" role="switch" id={id} aria-checked={checked} disabled={disabled} className={`commandSwitch${small ? " isSmall" : ""}${className ? ` ${className}` : ""}`}
    onClick={() => onChange(!checked)} {...aria}><span className="commandSwitchThumb" aria-hidden="true" /></button>;
}
