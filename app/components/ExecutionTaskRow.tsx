import type { ExecutionTask } from "../../shared/monitor-contract";
import { AgentChip } from "./AgentChip";
import { ExecutionTaskWallTimeText } from "./LiveTime";

function taskGlyph(task: ExecutionTask) {
  if (task.status === "running") return "◷";
  if (task.status === "completed") return "✓";
  return task.status === "failed" ? "!" : "×";
}

export function ExecutionTaskRow({ task }: { task: ExecutionTask }) {
  const running = task.status === "running";
  return (
    <div className={`executionTaskRow ${task.status}`}>
      <span className="executionTaskState" aria-hidden="true">{taskGlyph(task)}</span>
      <div>
        <div className="executionTaskTitleLine">
          <strong>{task.label}</strong>
          {task.signal && <AgentChip className={`executionTaskSignal ${task.signal.tone}`} title="Reported for this task through the Threadlight MCP tool">{task.signal.label}</AgentChip>}
        </div>
        <small>
          Shell · {running && task.background ? "background · " : ""}<ExecutionTaskWallTimeText task={task} />
          {!running && task.exitCode !== null ? ` · exit ${task.exitCode}` : ""}
        </small>
      </div>
    </div>
  );
}
