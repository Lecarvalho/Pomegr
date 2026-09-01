import type { ComponentPropsWithoutRef } from "react";
import styles from "./ExternalLink.module.css";

export type ExternalLinkProps = Omit<ComponentPropsWithoutRef<"a">, "rel" | "target">;

/**
 * Inline link for destinations that open outside Pomegr in a new browser tab.
 * The fixed icon and accessible suffix make that context change predictable.
 */
export function ExternalLink({ children, "aria-label": ariaLabel, ...props }: ExternalLinkProps) {
  const accessibleLabel = ariaLabel
    ? `${ariaLabel}; opens in a new tab`
    : typeof children === "string"
      ? `${children} (opens in a new tab)`
      : undefined;

  return <a {...props} aria-label={accessibleLabel} target="_blank" rel="noopener noreferrer">
    {children}
    <svg className={styles.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 11 11 5M6 5h5v5" />
    </svg>
    {!accessibleLabel && <span className={styles.visuallyHidden}> (opens in a new tab)</span>}
  </a>;
}
