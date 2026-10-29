import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = (name: string) => readFileSync(join(process.cwd(), "app", "styles", name), "utf8");
const rule = (styles: string, selector: string) => styles.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

// T-190: no cell, tab, or segment runs into its neighbour on a phone.
describe("Phone layout overlaps", () => {
  it("sizes the peak time and metric columns to their content on one shared grid", () => {
    const evidence = css("evidence.css");
    expect(evidence).not.toMatch(/\.resourcePeaksRow\s*\{[^}]*grid-template-columns:\s*\d+px/);
    expect(rule(evidence, ".resourcePeaksRows")).toMatch(/grid-template-columns:\s*max-content max-content minmax\(0, 1fr\) 48px/);
    expect(rule(evidence, ".resourcePeaksRow")).toMatch(/grid-template-columns:\s*subgrid/);
  });

  it("never shrinks a phone session tab below its label and badge", () => {
    const tab = rule(css("session.css"), ".sessionPhoneTabs button");
    expect(tab).not.toMatch(/min-width:\s*0/);
    expect(tab).toMatch(/white-space:\s*nowrap/);
  });

  it("never shrinks a Group by segment below its label on phone, without changing the shared segment rule", () => {
    expect(rule(css("workspace.css"), ".commandSessionGroupBy .commandSegmented > button")).toMatch(/flex:\s*1 0 auto;\s*padding-inline:\s*var\(--space-2\)/);
    expect(rule(css("shell.css"), "  .commandSegmented > button")).toMatch(/flex:\s*1 1 0;\s*min-width:\s*0/);
  });
});
