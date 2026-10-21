import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The calm task modal (owner-approved design, 2026-10-20): the Run settings rows, the Review panel, the Task read view, the composer's foot
// strip, the GitHub issue confirmation and the modal's header and footer. The contract is the owner page; the styles use tokens only.

const root = process.cwd();
const read = (...path: string[]) => readFileSync(join(root, ...path), "utf8").replace(/\r\n/g, "\n");
const tasksStyles = read("app", "styles", "tasks.css");
const issuesStyles = read("app", "styles", "task-issues.css");
const designPages = join(root, "docs", "internal", "design");
const contract = [join(root, "DESIGN.md"), ...readdirSync(designPages).sort().map((name) => join(designPages, name))].map((path) => readFileSync(path, "utf8")).join("\n");
const modalPage = read("docs", "internal", "design", "task-modal.md");
const tasks = join("app", "components", "tasks");

/** The declarations of the rule that opens a line with this exact selector. */
function rule(styles: string, selector: string) {
  const escaped = selector.replace(/[.[\]":()+>*,~|^$]/g, "\\$&");
  const match = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `${selector} rule`).not.toBeNull();
  return match![1];
}

describe("the Run settings list", () => {
  it("is a ruled list of 148px labels and values, 40px for text and 44px for a control, one column at 520px", () => {
    expect(rule(tasksStyles, ".taskRow")).toMatch(/grid-template-columns: 148px minmax\(0, 1fr\);[^}]*min-height: 40px;[^}]*border-top: 1px solid var\(--command-line\)/);
    expect(rule(tasksStyles, ".taskRow:last-child")).toMatch(/border-bottom: 1px solid var\(--command-line\)/);
    expect(rule(tasksStyles, ".taskRow:has(:is(.commandSelect, .commandSegmented, input))")).toMatch(/min-height: 44px/);
    expect(rule(tasksStyles, ".taskRow > dt")).toMatch(/color: var\(--command-muted\);[^}]*400 var\(--text-xs\)\/1\.4 var\(--font-ui\)/);
    expect(rule(tasksStyles, ".taskRunSettingsHeading")).toMatch(/color: var\(--command-muted\); font: 500 var\(--text-xs\)/);
    expect(tasksStyles).toMatch(/@media \(max-width: 520px\) \{\s*\.taskRow, [^{]*\{ grid-template-columns: minmax\(0, 1fr\);/);
    expect(rule(tasksStyles, ".taskRowNone")).toMatch(/color: var\(--command-muted\)/);
  });

  it("grows the label of a row that starts with a control to 44px on a phone and a coarse pointer, except where the label sits over its value", () => {
    expect(rule(tasksStyles, ".taskRow.isTop > dt")).toMatch(/min-height: var\(--control-height\)/);
    expect(rule(tasksStyles, ".taskRow.isTopCheck > dt")).toMatch(/min-height: 28px/);
    expect(tasksStyles).toMatch(/@media \(min-width: 521px\) and \(max-width: 760px\), \(min-width: 521px\) and \(pointer: coarse\) \{\s*\.taskRow\.isTop > dt, \.taskRow\.isTopCheck > dt \{ min-height: 44px; \}\s*\}/);
    // The block follows the 520px one, so the stacked label keeps no height of its own.
    expect(tasksStyles.indexOf("(min-width: 521px) and (max-width: 760px)")).toBeGreaterThan(tasksStyles.indexOf("@media (max-width: 520px)"));
  });

  it("draws a CommandSelect in a value column as the value: no border, no fill, a muted chevron, a 6% ink hover fill", () => {
    expect(rule(tasksStyles, ".taskValueSelect .commandSelectTrigger")).toMatch(/border-color: transparent; background: transparent; font-weight: 400; font-size: var\(--text-sm\)/);
    expect(rule(tasksStyles, ".taskValueSelect .commandSelectTrigger:hover:not(:disabled), .taskValueSelect .commandSelectTrigger[aria-expanded=\"true\"]"))
      .toMatch(/background: color-mix\(in srgb, var\(--command-ink\) 6%, transparent\)/);
    expect(rule(tasksStyles, ".taskValueSelect .commandSelectTrigger:is([data-value=\"none\"], [data-value=\"\"])")).toMatch(/color: var\(--command-muted\)/);
    // The modifier is the shared select drawn another way: it takes no new class of its own and no new role in DESIGN.md.
    expect(read(tasks, "TaskFields.tsx")).toMatch(/<CommandSelect id=\{selectId\} aria-label="Run on" className="taskValueSelect"/);
    expect(read(tasks, "FeatureFields.tsx")).toMatch(/<CommandSelect id=\{featureId\} aria-label="Feature" className="taskValueSelect"/);
    expect(read(tasks, "TaskFields.tsx") + read(tasks, "FeatureFields.tsx")).not.toMatch(/<select/);
    expect(modalPage).toMatch(/It is the shared select drawn as the value, not a new role in \[DESIGN\.md\]/);
    expect(read("DESIGN.md")).not.toMatch(/taskValueSelect/);
  });

  it("sets Effort as four equal segments 280px wide", () => {
    expect(rule(tasksStyles, ".taskEffort")).toMatch(/grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); width: 280px; max-width: 100%/);
  });

  it("names the rows and their words in the owner page", () => {
    expect(modalPage).toMatch(/The list holds these rows in order: Feature, Run on, Effort, Remote Control, When done, Complete when, and, in mode edit, GitHub issue, Runs after, Sessions, and Start at\./);
    expect(modalPage).toMatch(/one native checkbox with the muted hint “Open the session on your phone too”/);
    expect(modalPage).toMatch(/native checkbox labelled \*\*Remove worktree and branch\*\*, with the muted hint “Unpushed work is kept”/);
    expect(modalPage).not.toMatch(/Remove worktree and branch when done|Starts the session with Remote Control/);
  });
});

describe("the composer's foot strip", () => {
  it("has the panel radius and one foot with Attach image, the hint, and the counter, and no helper paragraph", () => {
    expect(rule(tasksStyles, ".taskComposer")).toMatch(/border: 1px solid var\(--command-line-strong\); border-radius: var\(--panel-radius\); background: var\(--command-panel\)/);
    expect(rule(tasksStyles, ".taskImagesHead")).toMatch(/display: flex; align-items: center;[^}]*border-top: 1px solid var\(--command-line\)/);
    expect(rule(tasksStyles, ".taskImagesHint")).toMatch(/flex: 1 1 auto;[^}]*color: var\(--command-muted\)/);
    expect(rule(tasksStyles, ".taskImagesHead .taskTextCounter")).toMatch(/margin-inline-start: auto/);
    const fields = read(tasks, "TaskFields.tsx");
    expect(fields).toMatch(/<TaskImageAttach held=\{taskImageIds\(value\)\.length\}[^>]*hintId=\{hintId\}[\s\S]*>\{counter\}<\/TaskImageAttach>/);
    expect(fields).not.toMatch(/TASK_IMAGE_HELPER|imageHelperId/);
    expect(read(tasks, "TaskImages.tsx")).toMatch(/<ImageGlyph \/>Attach image<\/button>/);
    expect(read(tasks, "task-images-desktop.ts")).toMatch(/TASK_IMAGE_HINT = `or paste one · up to \$\{TASK_BOUNDS\.imagesPerTask\}, \$\{MEGABYTES\} MB each`/);
    expect(modalPage).toMatch(/the muted hint “or paste one · up to 4, 5 MB each”, and the counter at the end/);
  });
});

describe("the Review panel and the Task read view", () => {
  it("draws the panel on the raised fill with the panel radius and 16px padding, and each result row at 28px", () => {
    expect(rule(tasksStyles, ".taskReview")).toMatch(/gap: var\(--space-3\); padding: var\(--space-4\); border-radius: var\(--panel-radius\); background: var\(--command-panel-2\)/);
    expect(rule(tasksStyles, ".taskReviewHeading")).toMatch(/font: 600 var\(--text-base\)\/1\.4/);
    expect(rule(tasksStyles, ".taskReviewCheck")).toMatch(/min-height: 28px/);
    expect(tasksStyles).toMatch(/\.taskReviewCheck:has\(\.isPassed\) > svg \{ color: var\(--command-green\); \}/);
    expect(read(tasks, "TaskReviewPanel.tsx")).toMatch(/<ul className="taskReviewChecks" aria-label="Complete when">/);
    expect(modalPage).toMatch(/A result is \*\*Passed\*\* \(green, with a check glyph\), \*\*Not passed\*\* \(error\), \*\*Not verified\*\* \(muted\), or \*\*Agent-reported\*\* \(muted\)\./);
  });

  it("draws the title at 16px/650 and the document at 14px/1.6, with code and data in the data font at 12px", () => {
    expect(rule(tasksStyles, ".taskReadTitle")).toMatch(/font: 650 var\(--text-heading\)\/1\.35 var\(--font-ui\)/);
    expect(rule(tasksStyles, ".taskDocument")).toMatch(/gap: 14px;[^}]*font: 400 var\(--text-base\)\/1\.6 var\(--font-ui\)/);
    expect(rule(tasksStyles, ".taskDocBlock")).toMatch(/white-space: pre-wrap/);
    for (const selector of [".taskDocCode", ".taskDocData"]) {
      expect(rule(tasksStyles, selector)).toContain("var(--font-data)");
      expect(rule(tasksStyles, selector)).toMatch(/font-size: var\(--text-xs\)/);
    }
    expect(rule(tasksStyles, ".taskDocData")).toMatch(/^ color: var\(--command-muted\);/);
    expect(rule(tasksStyles, ".taskReadNote")).toMatch(/font: 400 var\(--text-xs\)\/1\.4/);
  });

  it("draws the text as React elements and never sets markup", () => {
    const sources = ["TaskReadView.tsx", "TaskReviewPanel.tsx", "TaskRunSettingsRead.tsx", "TaskRows.tsx", "task-document.ts"].map((name) => read(tasks, name)).join("\n");
    expect(sources).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|console\.|<a |href=/);
    expect(read(tasks, "TaskReadView.tsx")).toMatch(/<img key=\{index\} className=\{`taskInlineImage/);
    expect(modalPage).toMatch(/The text is drawn as React text, never as HTML or Markdown\./);
    expect(modalPage).toMatch(/Code, UUIDs, and dates are a display heuristic, not a judgment about the task\./);
  });

  it("documents the lock line, the order of the body, and the panel's words", () => {
    expect(modalPage).toMatch(/The lock line reads “Started, so read-only\. Requeue to edit\.” while Requeue is offered/);
    expect(modalPage).toMatch(/The body order is the Review panel, the Task read view, and the Run settings as values, which end with the rows Runs after and Sessions\./);
    expect(modalPage).toMatch(/\*\*Ready for your review\*\* for Needs review, and the state's own name for Stalled and Blocked by agent/);
    expect(modalPage).toMatch(/The subtitle is the repository name alone\./);
    expect(modalPage).toMatch(/In modes new and promote the subtitle reads “repository · in column”\./);
  });
});

describe("the GitHub issue row", () => {
  it("opens a raised confirmation group with the strong line and the control radius, and its facts, in place of None", () => {
    expect(rule(issuesStyles, ".taskIssueConfirm")).toMatch(/border: 1px solid var\(--command-line-strong\); border-radius: var\(--control-radius\); background: var\(--command-panel-2\)/);
    expect(rule(issuesStyles, ".taskIssueConfirmFacts")).toMatch(/color: var\(--command-muted\); font: 400 var\(--text-xs\)\/1\.5/);
    const issue = read(tasks, "IssueCreate.tsx");
    expect(issue).toMatch(/role="group" aria-label="Confirm GitHub issue"/);
    expect(issue).toMatch(/className="commandSecondaryAction" disabled=\{creating \|\| disabled\} aria-describedby=\{factsId\}[^\n]*"Create issue"/);
    expect(issue).toMatch(/className="commandQuietAction" disabled=\{creating\} onClick=\{closeGroup\}>Cancel<\/button>/);
    expect(issue).toMatch(/className="commandQuietAction taskIssueCreateAction" disabled=\{disabled\} onClick=\{openGroup\}>Create issue…<\/button>/);
    // The New task checkbox keeps its own helper, and the Source block is for the promote form alone.
    expect(issue).toMatch(/export const ISSUE_CREATE_HELPER = "The task text is sent to GitHub once, with its first line as the issue title\./);
    expect(read(tasks, "TaskModalEdit.tsx")).not.toMatch(/TaskModalSource|IssueCreateRow\b/);
    expect(modalPage).toMatch(/- Nothing is sent before \*\*Create issue\*\*\.\n- \*\*Cancel\*\* closes the group and sends nothing\./);
    expect(modalPage).toMatch(/The first fact is the monitor's own rule: the title is the first line and the body is the whole saved text/);
  });

  it("keeps the privacy meaning in the contract and the public guide", () => {
    const tasksPage = read("docs", "internal", "architecture", "tasks.md");
    expect(tasksPage).toMatch(/It opens a confirmation in the row\s+that says what is sent/);
    expect(tasksPage).toMatch(/Nothing is sent before \*\*Create issue\*\* in the confirmation\./);
    const guide = read("docs", "public", "using-pomegr", "github-issues.md");
    expect(guide).toMatch(/Select \*\*Create issue…\*\* at the end of the row\./);
    expect(guide).toMatch(/Select\s+\*\*Create issue\*\* to send it, or \*\*Cancel\*\* to send nothing\./);
    expect(guide).not.toMatch(/Create GitHub issue|Not on GitHub|\*\*Source\*\* row/);
  });
});

describe("the footer", () => {
  it("is one row: Delete task, the notes, then the actions of the state, with Mark done or Save as the primary", () => {
    const edit = read(tasks, "TaskModalEdit.tsx");
    expect(edit).not.toMatch(/taskModalResolve/);
    expect(edit).toMatch(/<div className="taskModalNotes">/);
    const order = ["Open folder", "Start in separate worktree", "Add to queue", "Start session", "Requeue task", "{resolveName}", ">Mark done<", ">Save<"];
    const positions = order.map((word) => edit.indexOf(word, edit.indexOf("footer={<>")));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(rule(tasksStyles, ".taskModalNotes")).toMatch(/flex: 1 1 160px; min-width: 0/);
    expect(modalPage).toMatch(/Then the actions, in this order: \*\*Open folder\*\*, \*\*Start in separate worktree\*\*, \*\*Add to queue\*\* or \*\*Remove from queue\*\*, \*\*Start session\*\*, \*\*Requeue task\*\*, \*\*Mark done\*\*, and \*\*Save\*\*\./);
    expect(modalPage).toMatch(/\| Needs review \| \*\*Delete task\*\*, \*\*Requeue task\*\*, primary \*\*Mark done\*\* \|/);
  });
});

describe("Runs after, Sessions, and Start at rows", () => {
  it("draws the items without rules or a legend, then one add line with the borderless select and the Secondary action", () => {
    expect(rule(tasksStyles, ".taskSessions")).toMatch(/align-self: stretch;[^}]*flex-direction: column/);
    expect(rule(tasksStyles, ".taskSessionsItem")).toMatch(/min-height: var\(--control-height\)/);
    expect(rule(tasksStyles, ".taskSessionsItem")).not.toMatch(/border/);
    expect(tasksStyles).not.toMatch(/\.taskSessions legend/);
    expect(rule(tasksStyles, ".taskSessionsAssign")).toMatch(/display: flex; align-items: center/);
    expect(rule(tasksStyles, ".taskSessionsAssign > .commandSelect.taskValueSelect")).toMatch(/margin-inline-start: calc\(-1 \* var\(--space-3\) - 1px\)/);
    expect(rule(tasksStyles, ".taskRow .commandQuietAction, .taskRow .commandSecondaryAction")).toMatch(/width: auto/);
    for (const name of ["TaskAfterField.tsx", "TaskSessionsField.tsx"]) {
      const source = read(tasks, name);
      expect(source).not.toMatch(/<fieldset|<legend/);
      expect(source).toMatch(/<CommandSelect id=\{selectId\}[^>]*className="taskValueSelect"/);
    }
  });

  it("sizes Start at compact: about 220px, never wider than the value, 32px on a fine pointer and 44px otherwise", () => {
    expect(rule(tasksStyles, ".taskStartTimeField input[type=\"datetime-local\"]")).toMatch(/width: 220px; max-width: 100%; min-height: var\(--control-compact\)/);
    expect(tasksStyles).toMatch(/@media \(max-width: 760px\), \(pointer: coarse\) \{ \.taskStartTimeField input\[type="datetime-local"\] \{ min-height: 44px; \} \}/);
    expect(rule(tasksStyles, ".taskRowInline")).toMatch(/display: flex; flex-wrap: wrap; align-items: center/);
    // The base time field of the Schedule panel keeps its control height.
    expect(rule(tasksStyles, ".taskTimeInput")).toMatch(/min-height: var\(--control-height\)/);
  });

  it("states the rows, the hints, and the field's size in the owner pages", () => {
    expect(modalPage).toMatch(/\*\*Runs after\*\*, \*\*Sessions\*\*, and \*\*Start at\*\* are the last rows of the same Run settings list, in that order, after GitHub issue\./);
    expect(modalPage).toMatch(/One muted hint closes the value: “Starts only when every task here is Done or deleted\.”/);
    expect(modalPage).toMatch(/One muted hint closes the value: “An assigned session can report this task complete or blocked\.”/);
    expect(modalPage).toMatch(/One muted hint closes the value: “The agent judges Validated with the user and your own condition\.”/);
    expect(modalPage).toMatch(/the muted hint “Starts at this time or later; setting it queues the task\.”/);
    expect(modalPage).toMatch(/The field is compact: 32px high on a fine pointer, and 44px at 760px and narrower and on a coarse pointer\./);
    expect(modalPage).not.toMatch(/Runs after is a fieldset|Sessions\*\* follows Runs after\. It is a fieldset/);
    expect(read("docs", "internal", "design", "task-board.md")).toMatch(/In that row the field is compact: 32px high on a fine pointer, 44px on a coarse pointer and at 760px and narrower, about 220px wide/);
  });
});

describe("the samples and the tokens", () => {
  it("renders the four edit samples and the issue row samples on /design-system", () => {
    const sample = read("app", "components", "design-system", "DesignSystemTaskFieldsSample.tsx");
    for (const label of ["Task modal, edit\"", "Task modal, edit, needs review\"", "Task modal, edit, running\"", "Task modal, edit, create issue\"", "Review panel, needs review", "Task, read view", "GitHub issue, confirmation"]) {
      expect(sample).toContain(`label="${label.replace(/"$/, "")}`);
    }
    expect(sample).not.toMatch(/<TaskModalFrame|TaskModalSource/);
    expect(read("app", "styles", "design-system.css")).toMatch(/\.designSystemModalGrid \{ grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 680px\), 1fr\)\); \}/);
  });

  it("uses tokens only in the styles of the modal: no literal color, no off-scale radius, no off-ramp font size", () => {
    for (const styles of [tasksStyles, issuesStyles]) {
      expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      for (const [, radius] of styles.matchAll(/border-radius:\s*([^;}]+)/g)) expect(radius.trim()).toMatch(/^(?:var\(--(?:control|panel)-radius\)|50%|0)$/);
      expect(styles).not.toMatch(/font(?:-size)?:[^;}]*\b\d+(?:\.\d+)?px/);
    }
    expect(contract).toMatch(/`TaskModalFrame`/);
  });
});
