import type { Task } from "../../../shared/task-contract";
import { ProviderBadge } from "../ProviderBadge";
import { PROVIDER_LABELS, plannedRunText } from "./task-fields";

/** The planned provider badge and "model · effort", each only when set; nothing at all when neither is. */
export function TaskRunLine({ run }: { run: Task["run"] }) {
  const planned = plannedRunText(run);
  if (!run.provider && !planned) return null;
  return <div className="taskCardRun">
    {run.provider && <ProviderBadge source={PROVIDER_LABELS[run.provider]} />}
    {planned && <span className="taskCardPlanned">{planned}</span>}
  </div>;
}
