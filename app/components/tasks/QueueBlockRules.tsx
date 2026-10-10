"use client";

import { useId } from "react";
import { taskStateLabels } from "./task-presentation";

/** Design contract D181-D183: each rule ends in the state it gives, in that state's tone. */
const RULES = [
  { when: "The session ends with no report: ", state: "stalled", tone: "isError" },
  { when: "The agent reports it cannot continue: ", state: "blocked", tone: "isError" },
] as const;

/**
 * The two outcomes that stop the queue (design contract D178-D183, D450), and the one that does not: a task in Review is
 * finished work, so the queue goes on past it. Fixed copy, so it is drawn for any ready board.
 */
export function QueueBlockRules() {
  const headingId = useId();
  return <section className="panel taskQueuePanel taskBlockRulesPanel" aria-labelledby={headingId}>
    <h3 id={headingId} className="taskQueueHeading">When the queue blocks</h3>
    <ul className="taskBlockRules">
      {RULES.map((rule) => <li key={rule.state}>{rule.when}<span className={`taskBlockState ${rule.tone}`}>{taskStateLabels[rule.state]}</span></li>)}
    </ul>
    <p className="taskBlockRulesNote"><span className="taskBlockState isReview">{taskStateLabels.needs_review}</span> does not block the queue: the task waits in the Review column.</p>
  </section>;
}
