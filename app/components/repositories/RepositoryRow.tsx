import type { ReactNode } from "react";
import type { ProviderFeedback } from "./repository-setup-details";

export function RepositoryRow({ title, label, tone = "neutral", detail, feedback, actions }: {
  title: string;
  label: string;
  tone?: string;
  detail: ReactNode;
  feedback?: ProviderFeedback | null;
  actions: ReactNode;
}) {
  return <div className="commandSettingRow repositoryRow">
    <div className="repositoryRowInfo">
      <div className="repositoryRowTitle"><strong>{title}</strong><span className={`commandChip ${tone}`}>{label}</span></div>
      <p className="repositoryRowDetail">{detail}</p>
      {feedback && <p className={`repositorySetupFeedback ${feedback.tone}`} role="status">{feedback.message}</p>}
    </div>
    <div className="repositoryRowActions">{actions}</div>
  </div>;
}
