import type { ComponentProps, ReactNode } from "react";
import { CommandIcon, type CommandIconName } from "./CommandIcon";
export { CommandIcon } from "./CommandIcon";

export function CommandPage({ title, description, action, children, busy = false }: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  busy?: boolean;
}) {
  const headingId = `command-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-heading`;
  return <section className="commandView" aria-labelledby={headingId} aria-busy={busy || undefined}>
    <header className="commandViewIntro">
      <div className="commandPageHeading">
        <h1 id={headingId}>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="commandViewActions">{action}</div>}
    </header>
    {children}
  </section>;
}

export function CommandToolbar({ children, label = "Filters" }: { children: ReactNode; label?: string }) {
  return <div className="commandToolbar" role="toolbar" aria-label={label}>{children}</div>;
}

export function CommandSearch({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  return <label className="commandSearch">
    <CommandIcon name="search" size="small" />
    <span className="commandVisuallyHidden">{label}</span>
    <input type="search" value={value} onChange={(event) => onChange(event.currentTarget.value)} placeholder={placeholder} aria-label={label} />
  </label>;
}

export function CommandSelect({ className, ...props }: ComponentProps<"select">) {
  return <span className="commandSelect"><select {...props} className={className} /></span>;
}
export function CommandFilter({ active, children, onClick, count }: { active: boolean; children: ReactNode; onClick: () => void; count?: number }) {
  return <button className={`commandFilterChip${active ? " active" : ""}`} type="button" aria-pressed={active} onClick={onClick}>{children}{count === undefined ? null : <span className="commandFilterCount">{count}</span>}</button>;
}

export function CommandStatus({ state, children }: { state: "active" | "attention" | "idle" | "unknown"; children: ReactNode }) {
  return <span className={`commandStatusText ${state}`}><i className="commandStatusDot" aria-hidden="true" />{children}</span>;
}

export function CommandEmpty({ title, detail, icon = "spark" }: { title: string; detail: string; icon?: CommandIconName }) {
  return <section className="commandEmpty" aria-live="polite"><CommandIcon name={icon} /><h2>{title}</h2><p>{detail}</p></section>;
}

export function CommandComingSoon({ title, detail, icon = "spark" }: { title: string; detail: string; icon?: CommandIconName }) {
  return <section className="commandComingSoon"><span className="commandComingSoonIcon"><CommandIcon name={icon} /></span><div><span className="commandBadge">Coming soon</span><h2>{title}</h2><p>{detail}</p></div></section>;
}

export function CommandMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="commandMetric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}
