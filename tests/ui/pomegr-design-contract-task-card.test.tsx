import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The calm board (owner approved 2026-10-20): the card, its tags and chip, and the group toolbar. The contract is the root file and one page for each surface, read as one text.
const designPagesPath = join(process.cwd(), "docs", "internal", "design");
const designContract = [join(process.cwd(), "DESIGN.md"), ...readdirSync(designPagesPath).sort().map((name) => join(designPagesPath, name))]
  .map((path) => readFileSync(path, "utf8")).join("\n");
const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
const designSystemStyles = readFileSync(join(process.cwd(), "app", "styles", "design-system.css"), "utf8");

describe("Calm task board visual contract", () => {
  it("draws a card border as the only colored chrome: transparent at rest, the line on hover and focus, green or amber by state", () => {
    expect(styles).toMatch(/\.taskCard \{[^}]*border: 1px solid transparent; border-radius: var\(--panel-radius\)/);
    expect(styles).toMatch(/\.taskCard:where\(\.isOpenable\):where\(:hover, :focus-within\) \{ border-color: var\(--command-line\); \}/);
    expect(styles).toMatch(/\.taskCard\.isLive \{ border-color: var\(--command-green\); \}/);
    expect(styles).toMatch(/\.taskCard\.isAttention \{ border-color: var\(--command-amber\); \}/);
    // A lane has no fill at rest.
    expect(styles).not.toMatch(/\.taskColumn \{[^}]*background/);
    expect(designContract).toMatch(/The border turns amber for Needs review, Stalled, Blocked by agent, and Needs input\./);
  });

  it("draws the meta row, the tags and the run line with tokens", () => {
    expect(styles).toMatch(/\.taskCardTop \{ display: flex; flex-wrap: wrap; align-items: center; gap: var\(--space-1\) 6px; min-height: 20px; \}/);
    // The feature name asks for 64px only, so a narrow lane wraps the state chip to a second line and the name stays on the first.
    expect(styles).toMatch(/\.taskCardFeature \{ flex: 1 1 64px; min-width: 0;/);
    expect(styles).toMatch(/\.taskCardTop \.taskCardChip \{ margin-left: auto; \}/);
    expect(styles).toMatch(/\.taskCardFeature \{[^}]*min-width: 0; overflow: hidden; color: var\(--command-muted\); font: 400 var\(--text-xs\)[^}]*text-overflow: ellipsis; white-space: nowrap; \}/);
    expect(styles).toMatch(/\.taskTags \{ display: flex; flex-wrap: wrap; gap: var\(--space-1\);/);
    // A tag is the shared neutral chip: no tone and no color of its own.
    expect(styles).not.toMatch(/\.taskTag[^{]*\{[^}]*(?:color|background)/);
    expect(styles).toMatch(/\.taskCardPlanned \{[^}]*font: 400 var\(--text-caption\)\/1.4 var\(--font-data\)/);
    expect(styles).toMatch(/\.taskCardLink\.commandTextLink \{[^}]*color: var\(--command-muted\); \}/);
    expect(styles).toMatch(/\.taskCardLink\.commandTextLink:hover:not\(:disabled\) \{ color: var\(--command-ink\); text-decoration: none; \}/);
    expect(styles).not.toContain("taskCardExcerpt");
    expect(designContract).toMatch(/### Tags/);
    expect(designContract).toMatch(/The tag split is a display heuristic, like the title split\./);
    expect(designContract).toMatch(/A tag is the shared neutral .*\.commandChip.* \(`\.taskTag`\): muted text, no tone/);
  });

  it("states the chip rule for each lane in the design contract", () => {
    expect(designContract).toMatch(/### State chip on a card/);
    expect(designContract).toMatch(/draws its state chip only when its lane does not already say that state/);
    expect(designContract).toMatch(/\| Ready \| Queued, when the card is not next \| \*\*Next\*\*, Scheduled, Not queued, and every other state \|/);
    expect(designContract).toMatch(/\*\*Next\*\* replaces \*\*Queued · next\*\* on the board only\./);
  });

  it("keeps the group toolbar invisible, not removed, until the group is hovered or holds focus", () => {
    expect(styles).toMatch(/\.taskReadyActions \{[^}]*opacity: 0; \}/);
    expect(styles).not.toMatch(/\.taskReadyActions[^{]*\{[^}]*(?:display: none|visibility: hidden|transition|animation)/);
    expect(styles).toMatch(/\.taskReadyGroup:hover \.taskReadyActions, \.taskReadyGroup:focus-within \.taskReadyActions \{ opacity: 1; \}/);
    // A coarse pointer and a phone always see it, and the actions are 44px there.
    expect(styles).toMatch(/@media \(max-width: 760px\), \(pointer: coarse\) \{ \.taskReadyActions \{ opacity: 1; \} \}/);
    expect(styles).toMatch(/\.taskReadyUngroup\.commandQuietAction, \.taskMoveLeave\.commandQuietAction \{ width: auto; min-height: 44px; \}/);
    expect(designContract).toMatch(/The toolbar is invisible \(opacity 0, never `display: none`, so it stays keyboard-reachable\) until the group is hovered or holds focus/);
    expect(designSystemStyles).toMatch(/\.designSystemRevealGroup \.taskReadyActions \{ opacity: 1; \}/);
  });
});
