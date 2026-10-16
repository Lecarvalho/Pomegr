import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "app", "styles", "workspace.css"), "utf8");
const sessionTier = (width: number) => styles.match(new RegExp(`@container session-table \\(max-width: ${width}px\\) \\{([\\s\\S]*?)\\r?\\n\\}`))?.[1] ?? "";

// T-149: the session list fits its panel at every width, so a restored desktop window never scrolls it sideways.
describe("Sessions table width", () => {
  it("has no fixed minimum width and sizes to its own panel", () => {
    expect(styles).not.toMatch(/\.commandSessionTable[^{]*\{[^}]*min-width:\s*\d{4}px/);
    expect(styles).toMatch(/\.commandTableWrap:has\(> \.commandSessionTable\)\s*\{\s*container:\s*session-table \/ inline-size/);
  });

  it("keeps the filter chips on one line and moves Group by by the toolbar's own width", () => {
    expect(styles).toMatch(/\.commandSessionsToolbar\s*\{\s*container:\s*session-toolbar \/ inline-size/);
    expect(styles).toMatch(/\.commandSessionsToolbar \.commandToolbar\s*\{[^}]*grid-template-columns:\s*minmax\(240px, 360px\) max-content minmax\(0, 1fr\)/);
    expect(styles).toMatch(/@container session-toolbar \(max-width: 1039px\)\s*\{[^@]*\.commandSessionGroupBy\s*\{\s*grid-column:\s*1 \/ -1/);
    expect(styles).not.toMatch(/@media \(max-width: 1240px\)\s*\{\s*\.commandSessionsToolbar/);
  });

  it("folds Last activity under the title at a restored width", () => {
    for (const [width, scope] of [[1379, ".commandSessionTable:has(.commandSessionColTask)"], [1179, ".commandSessionTable"]] as const) {
      const tier = sessionTier(width);
      // A group header spans every column, so Last activity collapses to zero width instead of dropping its cells.
      expect(tier).toContain(`${scope} .commandSessionColActivity { width: 0; }`);
      expect(tier).toContain(`${scope} .commandTableActivityColumn > * { display: none; }`);
      expect(tier).toContain(`${scope} .commandTableActivity.agentChip.commandTableActivityCompact { display: flex; }`);
      expect(tier).not.toMatch(/colgroup|\.commandTableActivityColumn \{ display: none/);
    }
  });

  it("stacks rows with labelled fields in a narrow panel", () => {
    const stacked = sessionTier(999);
    expect(stacked).toMatch(/\.commandTableActivityColumn\s*\{\s*display:\s*none/);
    expect(stacked).toMatch(/\.commandTableActivityCompact\s*\{[^}]*display:\s*flex/);
    expect(stacked).toMatch(/\.commandSessionTable\s*\{[^}]*display:\s*block;[^}]*table-layout:\s*auto/);
    expect(stacked).toMatch(/\.commandSessionTable tbody tr\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\) 44px/);
    expect(stacked).toMatch(/\.commandSessionTable td\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/);
  });
});
