import type { ReactNode } from "react";

export function PanelHeader({ title, trailing, className = "" }: {
  title: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`panelHeader ${className}`.trim()}>
      <h2>{title}</h2>
      {trailing}
    </div>
  );
}
