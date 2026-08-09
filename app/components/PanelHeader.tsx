import type { ReactNode } from "react";

export function PanelHeader({ eyebrow, title, trailing, className = "" }: {
  eyebrow: string;
  title: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`panelHeader ${className}`.trim()}>
      <div><span className="label">{eyebrow}</span><h2>{title}</h2></div>
      {trailing}
    </div>
  );
}
