import type { AgentChatProposal } from "../../../shared/agent-chat-contract";
import type { Task } from "../../../shared/task-contract";
import { describeOperation, operationOutcome, proposalChip, proposalNote, startProposalTask, type OperationTitlePart } from "./agent-chat-presentation";

type BoardTask = Pick<Task, "id" | "text">;

function Title({ parts }: { parts: OperationTitlePart[] }) {
  return <>{parts.map((part, index) => (typeof part === "string"
    ? <span key={index}>{part}</span>
    : <code key={index} className="agentChatTaskId">{part.id}</code>))}</>;
}

/**
 * What Aril proposes, one row for each operation, and the owner's answer. Every word is a fixed verb and a target set as text.
 * A session start is its own card: it is applied only in the desktop window (`startHere`), and it stays open to another
 * try while no session launched. `heldStart` names the gates that hold a task now, from the board's own readings.
 */
export function AgentChatProposalCard({ proposal, tasks, busy, startHere = false, heldStart, onApply, onDismiss }: {
  proposal: AgentChatProposal;
  tasks: readonly BoardTask[];
  busy: boolean;
  startHere?: boolean;
  heldStart?(taskId: string): string | null;
  onApply(proposalId: string): void;
  onDismiss(proposalId: string): void;
}) {
  const chip = proposalChip(proposal);
  const startTask = startProposalTask(proposal);
  // The card's one Primary. A session start has it only where the start can be applied.
  const primary = startTask === null ? "Apply changes" : startHere ? "Start session" : null;
  return <section className="agentChatProposal" aria-label={startTask === null ? "Proposed board changes" : "Proposed session start"} aria-busy={busy || undefined}>
    <header className="agentChatProposalHead">
      <p className="agentChatProposalSummary">{proposal.summary}</p>
      {chip && <span className={`commandChip ${chip.tone}`}>{chip.label}</span>}
    </header>
    <ol className="agentChatOps">
      {proposal.operations.map((operation, index) => {
        const row = describeOperation(operation, tasks);
        const result = proposal.results?.[index];
        const outcome = result ? operationOutcome(operation, result) : null;
        const held = result && "start" in result && result.start === "gate_held" && proposal.state === "pending" ? heldStart?.(operation.op === "start_session" ? operation.id : "") ?? null : null;
        return <li key={index} className="agentChatOp">
          <p className="agentChatOpTitle"><Title parts={row.title} /></p>
          {row.text && row.text.value !== "" && <p className={`agentChatOpText${row.text.muted ? " isMuted" : ""}`} title={row.text.whole}>{row.text.value}</p>}
          {row.details.map((detail) => <p key={detail} className="agentChatOpDetail">{detail}</p>)}
          {row.warning && <p className="agentChatOpWarning">{row.warning}</p>}
          {outcome && <p className={`agentChatOpResult is-${outcome.tone}`}>{outcome.text}</p>}
          {held && <p className="agentChatOpDetail">{held}</p>}
        </li>;
      })}
    </ol>
    {proposal.state === "pending" && <div className="agentChatProposalFoot">
      <div className="agentChatProposalActions">
        {primary && <button type="button" className="commandPrimaryAction" disabled={busy} onClick={() => onApply(proposal.id)}>{primary}</button>}
        <button type="button" className="commandQuietAction" disabled={busy} onClick={() => onDismiss(proposal.id)}>Dismiss</button>
      </div>
      <p className="agentChatProposalNote">{proposalNote(proposal, startHere)}</p>
    </div>}
  </section>;
}
