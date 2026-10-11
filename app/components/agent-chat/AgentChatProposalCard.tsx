import type { AgentChatProposal } from "../../../shared/agent-chat-contract";
import type { Task } from "../../../shared/task-contract";
import { PROPOSAL_CHIPS, describeOperation, operationOutcome, proposalNote, type OperationTitlePart } from "./agent-chat-presentation";

type BoardTask = Pick<Task, "id" | "text">;

function Title({ parts }: { parts: OperationTitlePart[] }) {
  return <>{parts.map((part, index) => (typeof part === "string"
    ? <span key={index}>{part}</span>
    : <code key={index} className="agentChatTaskId">{part.id}</code>))}</>;
}

/** What Aril proposes, one row for each operation, and the owner's answer. Every word is a fixed verb and a target set as text. */
export function AgentChatProposalCard({ proposal, tasks, busy, onApply, onDismiss }: {
  proposal: AgentChatProposal;
  tasks: readonly BoardTask[];
  busy: boolean;
  onApply(proposalId: string): void;
  onDismiss(proposalId: string): void;
}) {
  const chip = proposal.state === "pending" ? null : PROPOSAL_CHIPS[proposal.state];
  return <section className="agentChatProposal" aria-label="Proposed board changes" aria-busy={busy || undefined}>
    <header className="agentChatProposalHead">
      <p className="agentChatProposalSummary">{proposal.summary}</p>
      {chip && <span className={`commandChip ${chip.tone}`}>{chip.label}</span>}
    </header>
    <ol className="agentChatOps">
      {proposal.operations.map((operation, index) => {
        const row = describeOperation(operation, tasks);
        const result = proposal.results?.[index];
        const outcome = result ? operationOutcome(operation, result) : null;
        return <li key={index} className="agentChatOp">
          <p className="agentChatOpTitle"><Title parts={row.title} /></p>
          {row.text && row.text.value !== "" && <p className={`agentChatOpText${row.text.muted ? " isMuted" : ""}`} title={row.text.whole}>{row.text.value}</p>}
          {row.details.map((detail) => <p key={detail} className="agentChatOpDetail">{detail}</p>)}
          {row.warning && <p className="agentChatOpWarning">{row.warning}</p>}
          {outcome && <p className={`agentChatOpResult is-${outcome.tone}`}>{outcome.text}</p>}
        </li>;
      })}
    </ol>
    {proposal.state === "pending" && <div className="agentChatProposalFoot">
      <div className="agentChatProposalActions">
        <button type="button" className="commandPrimaryAction" disabled={busy} onClick={() => onApply(proposal.id)}>Apply changes</button>
        <button type="button" className="commandQuietAction" disabled={busy} onClick={() => onDismiss(proposal.id)}>Dismiss</button>
      </div>
      <p className="agentChatProposalNote">{proposalNote(proposal)}</p>
    </div>}
  </section>;
}
