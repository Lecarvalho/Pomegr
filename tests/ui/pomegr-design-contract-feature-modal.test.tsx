import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The contract is the root file and one page for each surface. Read them as one text, so a rule may move between pages.
const designPagesPath = join(process.cwd(), "docs", "internal", "design");
const designContract = [join(process.cwd(), "DESIGN.md"), ...readdirSync(designPagesPath).sort().map((name) => join(designPagesPath, name))]
  .map((path) => readFileSync(path, "utf8")).join("\n");

describe("Feature modal visual contract", () => {
  it("draws the Feature modal on the task modal's frame with the shared roles and tokens only, opened from the filter row, and documents it", () => {
    const tasksStyles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
    const dir = join(process.cwd(), "app", "components", "tasks");
    const modal = readFileSync(join(dir, "FeatureModal.tsx"), "utf8");
    const form = readFileSync(join(dir, "FeatureFormFields.tsx"), "utf8");
    const filter = readFileSync(join(dir, "FeatureFilter.tsx"), "utf8");
    const pane = readFileSync(join(dir, "TaskBoardPane.tsx"), "utf8");
    // Contract lines 6 and 12: the task modal's frame, one primary, and no scrim close while the form holds something to save.
    expect(modal).toMatch(/<TaskModalFrame title=\{feature \? "Feature" : "New feature"\}/);
    expect(modal).toMatch(/closeOnScrim=\{!holdsText && !busy && !deleting\}/);
    expect(modal).toMatch(/className="commandPrimaryAction" disabled=\{!canSubmit\}/);
    expect(modal).toMatch(/className="commandQuietAction" onClick=\{onClose\}>Cancel</);
    // Mode New feature draws no Delete feature: its footer is its own branch, and the edit footer is FeatureEditFooter.
    expect(modal).toMatch(/feature && counts\s*\? <FeatureEditFooter/);
    expect(modal).not.toMatch(/Delete feature/);
    // Lines 7 to 11: the fields use the task modal's input and helper classes, with the bounds of the contract.
    expect(form).toMatch(/className="newTaskField featureField"/);
    expect(form).toMatch(/className="taskOwnInput featureVersion"[^>]*maxLength=\{TASK_BOUNDS\.featureAppVersionLength\}/);
    expect(form).toMatch(/className="featureFieldFoot"/);
    expect(form).toMatch(/placeholder="What is this feature\?"/);
    expect(form).toMatch(/placeholder="What should every task of this feature know\?"/);
    expect(form).toMatch(/className=\{`featureCounter\$\{over \? " isOver" : ""\}`\}/);
    expect(form).not.toMatch(/<textarea[^>]*maxLength/);
    // The four new rules use tokens only: the control height, the data font, the error colour, 44px on a phone.
    expect(tasksStyles).toMatch(/\.featureField \.taskOwnInput \{[^}]*min-height: var\(--control-height\)[^}]*padding: 0 var\(--space-3\)/);
    expect(tasksStyles).toMatch(/\.featureField \.featureVersion \{ max-width: 240px; font-family: var\(--font-data\); \}/);
    expect(tasksStyles).toMatch(/\.featureFieldFoot \{[^}]*justify-content: space-between[^}]*gap: var\(--space-3\)/);
    expect(tasksStyles).toMatch(/\.featureCounter \{[^}]*color: var\(--command-muted\)[^}]*font: 400 var\(--text-xs\)\/1\.4 var\(--font-data\)/);
    expect(tasksStyles).toMatch(/\.featureCounter\.isOver \{ color: var\(--command-error\); \}/);
    expect(tasksStyles).not.toMatch(/\.feature(?:Field|FieldFoot|Counter|Version)[^{]*\{[^}]*(?:#[0-9a-fA-F]{3,8}|rgba?\(|!important)/);
    // Lines 1 to 5: the filter row opens the modal in the desktop app only, and the inline name form is gone.
    expect(filter).toMatch(/\{entry && filter !== ALL_FEATURES && filter !== WITHOUT_FEATURE/);
    expect(filter).toMatch(/>Edit feature<\/button>/);
    expect(pane).toMatch(/features=\{desktop \? featureEntry : undefined\}/);
    expect(pane).toMatch(/\{desktop && ready && board\.features\.length === 0 && <NewFeatureAction/);
    expect(existsSync(join(dir, "AddFeatureAction.tsx"))).toBe(false);
    expect(tasksStyles).not.toMatch(/taskAddColumn/);
    // The design pages and the samples document it.
    expect(designContract).toMatch(/## Feature modal/);
    expect(designContract).toMatch(/Create feature\*\* is disabled until the trimmed title holds text/);
    expect(designContract).toMatch(/“Another feature already has this title\.”/);
    expect(designContract).toMatch(/“This board already holds 50 features\. Delete one first\.”/);
    expect(designContract).toMatch(/Quiet \*\*Edit feature\*\*/);
    const sample = readFileSync(join(process.cwd(), "app", "components", "design-system", "DesignSystemFeatureModalSample.tsx"), "utf8");
    expect(sample).toMatch(/TaskModalChrome/);
    expect(sample).not.toMatch(/<TaskModalFrame/);
  });

  it("draws Delete feature on the task modal's inline confirmation with its shared roles, and documents and samples it", () => {
    const dir = join(process.cwd(), "app", "components", "tasks");
    const footer = readFileSync(join(dir, "FeatureEditFooter.tsx"), "utf8");
    const form = readFileSync(join(dir, "FeatureFormFields.tsx"), "utf8");
    const tasksStyles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
    // Contract lines 21 to 23: Quiet Delete feature, spacer, Secondary Mark done or Reopen, primary Save; the confirmation is the task modal's group.
    expect(footer).toMatch(/className="commandQuietAction" disabled=\{blockerId !== null \|\| busy\} onClick=\{onAskDelete\}>Delete feature</);
    expect(footer).toMatch(/<span className="taskModalSpacer" aria-hidden="true" \/>\s*<button type="button" className="commandSecondaryAction" disabled=\{busy \|\| deleting\} onClick=\{onToggleDone\}>\{done \? "Reopen" : "Mark done"\}<\/button>\s*<button type="button" className="commandPrimaryAction" disabled=\{!canSave\} onClick=\{onSave\}>Save</);
    expect(footer).toMatch(/<div className="taskModalConfirm" role="group" aria-label="Confirm delete">/);
    expect(footer).toMatch(/className="commandSecondaryAction" disabled=\{deleting\} onClick=\{onDelete\}>Delete feature</);
    expect(footer).toMatch(/ref=\{keepRef\} type="button" className="commandQuietAction" disabled=\{deleting\} onClick=\{onKeep\}>Keep feature</);
    // Line 27: the started task's note sits in a taskModalResolve above the actions.
    expect(footer).toMatch(/<div className="taskModalResolve"><span className="taskModalNote">\{featureRunningLine\(blockerId\)\}<\/span><\/div>/);
    // Line 30: one fixed alert under the fields.
    expect(form).toMatch(/failure === "delete" && <p className="newTaskError" role="alert">\{FEATURE_DELETE_FAILURE_MESSAGE\}<\/p>/);
    // The confirmation fills the footer with a token-free rule, so its spacer can push the two actions right.
    expect(tasksStyles).toMatch(/\.taskModalFooter > \.taskModalConfirm \{ flex: 1 1 auto; \}/);
    expect(designContract).toMatch(/Quiet \*\*Delete feature\*\*, Secondary \*\*Mark done\*\* or \*\*Reopen\*\*, primary \*\*Save\*\*/);
    expect(designContract).toMatch(/“Delete this feature\? Its n tasks stay on the board with no feature\. This cannot be undone\.”/);
    expect(designContract).toMatch(/“T-n is running\. Delete the feature after its tasks finish\.”/);
    expect(designContract).toMatch(/“The feature could not be deleted\.”/);
    const sample = readFileSync(join(process.cwd(), "app", "components", "design-system", "DesignSystemFeatureModalSample.tsx"), "utf8");
    expect(sample).toMatch(/FeatureEditFooter/);
    for (const label of ["Feature modal, feature, done", "Feature modal, delete confirmation", "Feature modal, delete blocked", "Feature modal, could not delete"]) expect(sample).toContain(label);
    expect(sample).toMatch(/board=\{BOARD_BLOCKED\}/);
    expect(sample).toMatch(/confirm \/>/);
  });
});
