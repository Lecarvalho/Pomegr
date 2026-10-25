import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const layoutSource = readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8");
const styles = readFileSync(join(process.cwd(), "app/styles/tokens.css"), "utf8");

it("bundles fonts locally and never imports Google fonts in the app", () => {
  const appRoot = join(process.cwd(), "app");
  for (const file of readdirSync(appRoot, { recursive: true }) as string[]) {
    if (!/\.(?:[cm]?[jt]sx?|css)$/.test(file)) continue;
    expect(readFileSync(join(appRoot, file), "utf8"), file).not.toMatch(/next\/font\/google/);
  }
  expect(layoutSource).toContain('import "@fontsource-variable/inter"');
  expect(layoutSource).toContain('import "@fontsource-variable/cascadia-mono"');
  expect(styles).toContain('--font-ui: "Segoe UI", "Inter Variable", system-ui, sans-serif');
  expect(styles).toContain('--font-inter: var(--font-ui)');
  expect(styles).toContain('--font-data: "Cascadia Mono Variable", "Cascadia Mono", Consolas, monospace');
  for (const [token, size] of Object.entries({ caption: 12, xs: 14, sm: 15, base: 16, heading: 18, title: 28 })) {
    expect(styles).toContain(`--text-${token}: ${size}px`);
  }
  const dark = styles.match(/html\[data-theme="dark"\]\s*\{([^}]+)\}/)?.[1];
  expect(dark).toContain('--color-text: #cbcfd5');
  expect(dark).toContain('--color-muted: #8f96a0');
});
