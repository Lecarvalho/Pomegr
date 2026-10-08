import type { Task } from "../../../shared/task-contract";
import { ProviderBadge } from "../ProviderBadge";
import { PROVIDER_LABELS, observedModelDiffers, plannedRunText } from "./task-fields";

/**
 * The planned provider badge and "model · effort", each only when set, then what the session was observed using
 * (D82, D73): "Observed model: x" in muted text, or, when a planned model and the observed one differ, the single
 * amber line "Planned x, observed y". Default model planned has nothing to compare, so it shows the observed line.
 */
export function TaskRunLine({ run, observedModel = null }: { run: Task["run"]; observedModel?: string | null }) {
  const planned = plannedRunText(run);
  const hasRun = Boolean(run.provider) || Boolean(planned);
  if (!hasRun && !observedModel) return null;
  return <>
    {hasRun && <div className="taskCardRun">
      {run.provider && <ProviderBadge source={PROVIDER_LABELS[run.provider]} />}
      {planned && <span className="taskCardPlanned">{planned}</span>}
    </div>}
    {observedModel && (observedModelDiffers(run.model, observedModel)
      ? <p className="taskCardDetail taskCardModelDiffers">Planned <code>{run.model}</code>, observed <code>{observedModel}</code></p>
      : <p className="taskCardDetail">Observed model: <code>{observedModel}</code></p>)}
  </>;
}
