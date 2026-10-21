import type { Task } from "../../../shared/task-contract";
import { cardRunText, observedModelDiffers } from "./task-fields";

export function TaskRunLine({ run, observedModel = null }: { run: Task["run"]; observedModel?: string | null }) {
  const planned = cardRunText(run);
  if (!planned && !observedModel) return null;
  return <>
    {planned && <p className="taskCardPlanned">{planned}</p>}
    {observedModel && (observedModelDiffers(run.model, observedModel)
      ? <p className="taskCardDetail taskCardModelDiffers">Planned <code>{run.model}</code>, observed <code>{observedModel}</code></p>
      : <p className="taskCardDetail">Observed model: <code>{observedModel}</code></p>)}
  </>;
}
