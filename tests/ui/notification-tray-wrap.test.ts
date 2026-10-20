import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("notification tray long tokens", () => {
  const css = readFileSync(join(process.cwd(), "app/styles/shell.css"), "utf8");
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
  };

  it("never scrolls horizontally and keeps vertical scrolling", () => {
    const tray = rule(".commandNotificationTray");
    expect(tray).toContain("overflow-x: hidden");
    expect(tray).toContain("overflow-y: auto");
  });

  it("wraps long unbroken tokens inside each entry", () => {
    expect(rule(".commandNotificationEntry")).toContain("overflow-wrap: anywhere");
    expect(rule(".commandNotificationEntry")).toContain("minmax(0, 1fr)");
  });
});
