import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Planning before Ready and Runs after (T-101). The contract is the root file and one page for each surface, read as one text.
const designPagesPath = join(process.cwd(), "docs", "internal", "design");
const designContract = [join(process.cwd(), "DESIGN.md"), ...readdirSync(designPagesPath).sort().map((name) => join(designPagesPath, name))]
  .map((path) => readFileSync(path, "utf8")).join("\n");
const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
const read = (name: string) => readFileSync(join(process.cwd(), "app", "components", "tasks", name), "utf8");

describe("Planning and runs after visual contract", () => {
  it("queues a plan from its caption, opens Runs after from the toolbar, and documents both with samples", () => {
    // a plan's caption queues its group, and a card's toolbar opens Runs after.
    expect(read("ReadyGroup.tsx")).toMatch(/className="commandQuietAction taskReadyUngroup taskReadyQueue" onClick=\{actions\.onQueue\}>Queue group<\/button>/);
    expect(read("TaskMoveBar.tsx")).toMatch(/className="commandQuietAction taskMoveLeave taskMoveAfter" aria-haspopup="dialog" aria-label=\{`Choose what \$\{id\} runs after`\}[^]*>Runs after…<\/button>/);
    expect(read("TaskBoardView.tsx")).toMatch(/void edits\.queueGroup\(group\.tasks\[0\]\.id\);/);
    expect(styles).toMatch(/\.taskAfterId \{ font-family: var\(--font-data\); \}/);
    expect(designContract).toMatch(/A group with a Not queued card adds the Quiet \*\*Queue group\*\* \(`\.taskReadyQueue`\) before \*\*Ungroup\*\*\./);
    expect(designContract).toMatch(/### Runs after/);
    expect(designContract).toMatch(/ends with the Quiet \*\*Runs after…\*\* \(`\.taskMoveLeave\.taskMoveAfter`\)/);
    expect(designContract).toMatch(/“Runs after T-13 and T-14”, before the feature line\./);
    const modalContract = readFileSync(join(process.cwd(), "docs", "internal", "design", "task-modal.md"), "utf8");
    expect(modalContract).toMatch(/\*\*Runs after\*\* follows Complete when\. It is a fieldset with the 12px\/500 legend \*\*Runs after\*\*, built like Sessions\./);
    expect(modalContract).toMatch(/“These tasks would wait for each other, so nothing was changed\.”/);
    const field = read("TaskAfterField.tsx");
    expect(field).toMatch(/<fieldset className="taskSessions taskAfter">/);
    expect(field).toMatch(/className="commandSecondaryAction"[^]*?>Add<\/button>/);
    const plan = readFileSync(join(process.cwd(), "app", "components", "design-system", "DesignSystemTaskPlanSample.tsx"), "utf8");
    for (const label of ["Backlog lane, a plan", "Backlog lane, desktop app", "Ready lane, a card that runs after another", "Card, desktop app, Runs after…", "Task modal, Runs after", "Task modal, a loop refused", "Task modal, started task"]) expect(plan).toContain(`label="${label}"`);
  });
});
