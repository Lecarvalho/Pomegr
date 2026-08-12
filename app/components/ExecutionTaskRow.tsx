import type { ExecutionTask } from "../../shared/monitor-contract";
import { AgentChip } from "./AgentChip";
import { ExecutionTaskWallTimeText } from "./LiveTime";

function taskGlyph(task: ExecutionTask) {
  if (task.status === "running") return "◷";
  if (task.status === "completed") return "✓";
  return task.status === "failed" ? "!" : "×";
}

const FAILURE_CAUSE_COPY: Record<NonNullable<ExecutionTask["failureCause"]>, string> = {
  command_not_found: "the command or executable was not available",
  invalid_path: "a path was invalid for this operating system",
  network_error: "a network connection failed",
  not_found: "a referenced file or directory could not be found",
  non_zero_exit: "the shell returned a non-zero exit code",
  permission_denied: "the command was blocked by a permissions or sandbox restriction",
  provider_error: "the provider reported a shell error without a safe detail",
  syntax_error: "the shell or script could not parse the command",
  tests_failed: "one or more tests failed",
  timed_out: "the command exceeded its allowed run time",
};

function failureTooltip(task: ExecutionTask) {
  const cause = task.failureCause || (task.exitCode !== null && task.exitCode !== 0 ? "non_zero_exit" : "provider_error");
  const exitCode = task.exitCode !== null ? ` Exit code ${task.exitCode}.` : "";
  return `Cause: ${FAILURE_CAUSE_COPY[cause]}.${exitCode}`;
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
