"use client";

import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { SessionTaskCell, SessionTaskNote } from "../tasks/SessionTaskCell";
import { SAMPLE_FEATURE_ID, SAMPLE_REPOSITORY_ID } from "./DesignSystemTaskSampleData";
import { Sample, Section } from "./DesignSystemKit";

const reference = (id: string, state: SessionTaskReference["state"], feature: string | null = "Upload reliability", step: number | null = 2): SessionTaskReference => ({
  id, repositoryId: SAMPLE_REPOSITORY_ID, state, featureId: feature === null ? null : SAMPLE_FEATURE_ID, feature, step: feature === null ? null : step,
});

export function SessionTaskSection() {
  return <Section id="session-task-cell" title="Sessions list Task cell" lede="The Task column of the Sessions directory, shown second when the list can read tasks. It prints the task ID as a Text link to the repository board, an outcome chip only for what the session's own State cannot show, and the feature and step in muted text.">
    <div className="designSystemGrid">
      <Sample label="Working on the task" note="No chip: while the session works on the task, State is the only status."><SessionTaskCell task={reference("T-14", null)} /></Sample>
      <Sample label="Needs review" note="Warning tone: the user must act."><SessionTaskCell task={reference("T-12", "needs_review")} /></Sample>
      <Sample label="Stalled" note="Warning tone: the session ended with no report."><SessionTaskCell task={reference("T-12", "stalled")} /></Sample>
      <Sample label="Done" note="A plain outline chip."><SessionTaskCell task={reference("T-13", "done")} /></Sample>
      <Sample label="Under a Feature group" note="The group header already names the feature, so the line reads Step n."><SessionTaskCell task={reference("T-14", null)} omitFeature /></Sample>
      <Sample label="No feature" note="The ID alone, with no feature line."><SessionTaskCell task={reference("T-9", null, null)} /></Sample>
      <Sample label="Started by you" note="A dash, with a title that says the session was not started from a task."><SessionTaskCell task={null} /></Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Table footnote" note="One muted line under the table, shown with the Task column."><SessionTaskNote /></Sample>
    </div>
    <p className="designSystemNote">Not rendered here because they read the committed task board through the task store: the task line in the session header meta, the Task panel at the top of Overview, and the read-only Task tab. DESIGN.md specifies them under Session Evidence.</p>
  </Section>;
}
