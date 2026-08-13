import type { ExecutionTask } from "../../shared/monitor-contract";
import { AgentChip } from "./AgentChip";
import { ExecutionTaskWallTimeText } from "./LiveTime";

function taskGlyph(task: ExecutionTask) {
  if (task.status === "running") return "◷";
  if (task.status === "completed") return "✓";
  return task.status === "failed" ? "!" : "×";
}

const FAILURE_CAUSE_COPY: Record<NonNullable<ExecutionTask["failureCause"]>, string> = {
  command_not_found: "The command or executable was not available",
  invalid_path: "A path was invalid for this operating system",
  network_error: "A network connection failed",
  not_found: "A referenced file or directory could not be found",
  non_zero_exit: "The shell returned a non-zero exit code",
  permission_denied: "The command was blocked by a permissions or sandbox restriction",
  provider_error: "The provider reported a shell error without a safe detail",
  syntax_error: "The shell or script could not parse the command",
  tests_failed: "One or more tests failed",
  timed_out: "The command exceeded its allowed run time",
};

function failureTooltip(task: ExecutionTask) {
  const cause = task.failureCause || (task.exitCode !== null && task.exitCode !== 0 ? "non_zero_exit" : "provider_error");
  const exitCode = task.exitCode !== null ? ` Exit code ${task.exitCode}.` : "";
  return `${FAILURE_CAUSE_COPY[cause]}.${exitCode}`;
}

export function ExecutionTaskRow({ task }: { task: ExecutionTask }) {
  const running = task.status === "running";
  const failureDetails = task.status === "failed" ? failureTooltip(task) : null;
  return (
    <div className={`executionTaskRow ${task.status}`}>
      {failureDetails
        ? <AgentChip className="executionTaskState executionTaskFailureTrigger" title={failureDetails} ariaLabel={`Show failure cause. ${failureDetails}`}>{taskGlyph(task)}</AgentChip>
        : <span className="executionTaskState" aria-hidden="true">{taskGlyph(task)}</span>}
      <div>
        <div className="executionTaskTitleLine">
          <strong>{task.label}</strong>
          {task.signal && <AgentChip className={`executionTaskSignal ${task.signal.tone}`} title="Reported for this task through the Threadlight MCP tool">{task.signal.label}</AgentChip>}
        </div>
        <small>
          Shell · {running && task.background ? "background · " : ""}<ExecutionTaskWallTimeText task={task} />
          {!running && task.exitCode !== null ? ` · exit code ${task.exitCode}` : ""}
        </small>
      </div>
    </div>
  );
}
