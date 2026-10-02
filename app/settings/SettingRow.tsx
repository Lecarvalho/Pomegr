import type { ReactNode } from "react";

export function SettingRow({ label, description, children, className = "", labelFor, descriptionId }: {
  label: string;
  description: string;
  children: ReactNode;
  className?: string;
  labelFor?: string;
  descriptionId?: string;
}) {
  const copy = <><strong>{label}</strong><span id={descriptionId}>{description}</span></>;
  return (
    <div className={`commandSettingRow${className ? ` ${className}` : ""}`}>
      {labelFor ? <label htmlFor={labelFor}>{copy}</label> : <div>{copy}</div>}
      {children}
    </div>
  );
}

export function PreferenceRow({ id, label, description, checked, disabled = false, onChange }: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = `${id}-description`;
  return (
    <SettingRow className="displayPreferenceRow" label={label} description={description} labelFor={id} descriptionId={descriptionId}>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={descriptionId} onChange={(event) => onChange(event.currentTarget.checked)} />
    </SettingRow>
  );
}
