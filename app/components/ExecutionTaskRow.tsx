import type { ExecutionTask } from "../../shared/monitor-contract";
import { AgentChip } from "./AgentChip";
import { ExecutionTaskWallTimeText } from "./LiveTime";
import { WorkKindIcon } from "./WorkKindIcon";

function TaskStatusGlyph({ status }: { status: ExecutionTask["status"] }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 12 12">
    {status === "running" && <circle cx="6" cy="6" r="2.25" />}
    {status === "completed" && <path d="m2.5 6 2.25 2.25L9.5 3.5" />}
    {status === "failed" && <path d="M6 2.5v4M6 9.25v.01" />}
    {status === "stopped" && <path d="m3 3 6 6M9 3 3 9" />}
  </svg>;
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

export function ExecutionTaskRow({ task, compact = false }: { task: ExecutionTask; compact?: boolean }) {
  const running = task.status === "running";
  const failureDetails = task.status === "failed" ? failureTooltip(task) : null;
  const marker = <><WorkKindIcon kind={task.workKind} /><span className="executionTaskStatusBadge"><TaskStatusGlyph status={task.status} /></span></>;
  return (
    <div className={`executionTaskRow ${task.status}${compact ? " executionTaskRowCompact" : ""}`}>
      {failureDetails
        ? <AgentChip className="executionTaskMark executionTaskFailureTrigger" title={failureDetails} ariaLabel={`Show failure cause. ${failureDetails}`}>{marker}</AgentChip>
        : <span className="executionTaskMark" aria-hidden="true">{marker}</span>}
      <div>
        <div className="executionTaskTitleLine">
          <strong>{task.label}</strong>
          {task.signal && <AgentChip className={`executionTaskSignal ${task.signal.tone}`} title="Reported for this task through the Pomegr MCP tool">{task.signal.label}</AgentChip>}
        </div>
        <small>
          Shell · {running && task.background ? "background · " : ""}<ExecutionTaskWallTimeText task={task} />
          {!compact && !running && task.exitCode !== null ? ` · exit code ${task.exitCode}` : ""}
        </small>
      </div>
      {compact && <span className={`executionTaskExit${task.exitCode !== null && task.exitCode !== 0 ? " executionTaskExitError" : ""}`}>{running ? "running" : task.exitCode !== null ? `exit ${task.exitCode}` : task.status}</span>}
    </div>
  );
}
