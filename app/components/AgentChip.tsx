import type { ReactNode } from "react";

type AgentChipProps = {
  as?: "span" | "button";
  children: ReactNode;
  className?: string;
  title?: string;
  onClick?: () => void;
  expanded?: boolean;
  controls?: string;
};

export function AgentChip({ as = "span", children, className = "", title, onClick, expanded, controls }: AgentChipProps) {
  const classes = `agentChip ${as === "button" ? "agentChipButton" : ""} ${className}`.trim();
  if (as === "button") return (
    <button className={classes} type="button" onClick={onClick} aria-expanded={expanded} aria-controls={controls}>{children}</button>
  );
  return <span className={classes} title={title}>{children}</span>;
}
