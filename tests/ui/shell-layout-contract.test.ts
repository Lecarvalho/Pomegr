import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const styleEntry = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const styles = [...styleEntry.matchAll(/@import "\.\/(.+?\.css)";/g)]
  .map((match) => readFileSync(join(process.cwd(), "app", match[1]), "utf8")).join("\n");
const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));

it("lets the header reach the viewport edge while keeping vertical scrolling available", () => {
  const rootRules = rules.filter(({ selector }) => selector === "html" || selector === "body");
  expect(rootRules.length).toBeGreaterThan(0);
  for (const { body } of rootRules) {
    expect(body).not.toMatch(/scrollbar-gutter:\s*stable/);
    expect(body).not.toMatch(/overflow(?:-y)?:\s*(?:hidden|clip)/);
    expect(body).not.toMatch(/scrollbar-width:\s*none/);
  }
  expect(styles).toMatch(/\.commandHeader\s*\{[^}]*grid-column:\s*1 \/ -1/);
  expect(styles).toMatch(/\.commandMain\s*\{[^}]*overflow:\s*auto/);
});
