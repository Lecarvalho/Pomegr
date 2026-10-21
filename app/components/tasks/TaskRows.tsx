import { useId, type ReactNode } from "react";

/** The Run settings of the task modal: a muted heading over a ruled label/value list. The same rows hold controls in the forms and plain values in a started task. */
export function RunSettings({ children }: { children: ReactNode }) {
  const headingId = useId();
  return <section className="taskRunSettings" aria-labelledby={headingId}>
    <h3 id={headingId} className="taskRunSettingsHeading">Run settings</h3>
    <dl className="taskRows">{children}</dl>
  </section>;
}

/**
 * One row of the list: the label (dt) and its value (dd). A control in the value is named by the label (`htmlFor`) or by the
 * label's text (`labelId`). `end` is an action at the row's end. `top` aligns a tall value with its first line: the first line is a
 * control, a checkbox, or text.
 */
export function TaskRow({ label, htmlFor, labelId, className, top, end, children }: {
  label: string;
  htmlFor?: string;
  labelId?: string;
  className?: string;
  top?: "control" | "check" | "text";
  end?: ReactNode;
  children: ReactNode;
}) {
  const classes = ["taskRow", top === "control" ? "isTop" : top === "check" ? "isTopCheck" : top === "text" ? "isTopText" : null, className].filter(Boolean).join(" ");
  return <div className={classes}>
    <dt id={labelId}>{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}</dt>
    <dd>
      <div className="taskRowValue">{children}</div>
      {end}
    </dd>
  </div>;
}

/** A value that is not set, in muted text. */
export function TaskRowNone({ children }: { children: ReactNode }) {
  return <span className="taskRowNone">{children}</span>;
}
