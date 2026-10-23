import type { Task } from "../../../shared/task-contract";
import { cardRunText, observedModelDiffers } from "./task-fields";

export function TaskRunLine({ run, observedModel = null, observedEffort = null }: { run: Task["run"]; observedModel?: string | null; observedEffort?: string | null }) {
  const planned = cardRunText(run);
  if (!planned && !observedModel && !observedEffort) return null;
  return <>
    {planned && <p className="taskCardPlanned">{planned}</p>}
    {observedModel && (observedModelDiffers(run.model, observedModel)
      ? <p className="taskCardDetail taskCardModelDiffers">Planned <code>{run.model}</code>, observed <code>{observedModel}</code></p>
      : <p className="taskCardDetail">Observed model: <code>{observedModel}</code></p>)}
    {observedEffort && (run.effort && run.effort !== observedEffort
      ? <p className="taskCardDetail taskCardModelDiffers">Planned effort <code>{run.effort}</code>, observed <code>{observedEffort}</code></p>
      : <p className="taskCardDetail">Observed effort: <code>{observedEffort}</code></p>)}
  </>;
}
