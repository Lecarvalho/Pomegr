"use client";

import { useId } from "react";
import { taskStateLabels } from "./task-presentation";

const RULES = [
  { when: "The session ends with no report: ", state: "stalled", tone: "isError" },
  { when: "The agent reports it cannot continue: ", state: "blocked", tone: "isError" },
] as const;

export function QueueBlockRules({ embedded = false }: { embedded?: boolean }) {
  const headingId = useId();
  return <section className={`${embedded ? "" : "panel taskQueuePanel "}taskBlockRulesPanel`} aria-labelledby={headingId}>
    <h3 id={headingId} className="taskQueueHeading">When the queue blocks</h3>
    <ul className="taskBlockRules">
      {RULES.map((rule) => <li key={rule.state}>{rule.when}<span className={`taskBlockState ${rule.tone}`}>{taskStateLabels[rule.state]}</span></li>)}
    </ul>
    <p className="taskBlockRulesNote"><span className="taskBlockState isReview">{taskStateLabels.needs_review}</span> does not block the queue: the task waits in the Review column.</p>
  </section>;
}
