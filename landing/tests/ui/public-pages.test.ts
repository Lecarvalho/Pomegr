import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "../../worker/security-headers";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("public landing surfaces", () => {
  it("uses the painted mark in landing chrome", () => {
    const source = read("app/components/PomegrBrand.tsx");
    expect(source).toContain('src="/pomegr-logo.png?v=painted-1"');
    expect(source).toContain('alt="" width="35" height="35"');
    expect(statSync(new URL("../../public/favicon.svg", import.meta.url)).size).toBeLessThan(statSync(new URL("../../public/pomegr-logo.png", import.meta.url)).size);
  });

  it("keeps the landing page inside the isolated package", () => {
    const source = read("app/components/LandingPage.tsx");
    expect(source).toContain('<SiteHeader current="home" />');
    expect(source).toContain('<SiteFooter current="home" />');
    expect(source).toContain("Windows x64 · installer or portable");
    expect(source).toContain("iOS &amp; Android · planned");
    expect(source).toContain("Illustrative · sample data");
    expect(source).toContain('href={DOWNLOAD_URL}>Download for Windows');
    expect(source).toContain('const DOWNLOAD_URL = "/download"');
    expect(source).not.toContain("Field release · desktop, iOS, Android");
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/){3,}/);
    expect(source).not.toContain("issues/new");
  });

  it("offers no waitlist signup on any page while the waitlist API stays", () => {
    for (const file of ["app/components/LandingPage.tsx", "app/download/page.tsx"]) {
      const source = read(file);
      expect(source, file).not.toContain("Waitlist");
      expect(source, file).not.toContain("#waitlist");
    }
    expect(read("app/api/waitlist/route.ts")).toContain("createWaitlistHandlers");
  });

  it("folds About into Home and keeps the authoritative project links", () => {
    const about = read("app/about/page.tsx");
    const header = read("app/components/SiteHeader.tsx");
    const footer = read("app/components/SiteFooter.tsx");
    const chrome = read("app/components/SiteChrome.module.css");
    // Existing links to /about land on Home; no page links to it any more.
    expect(about).toContain('permanentRedirect("/")');
    expect(header).not.toContain('"/about"');
    expect(footer).not.toContain('"/about"');
    expect(read("app/sitemap.ts")).not.toContain("/about");
    expect(header).toContain('current: "home" | "docs" | "download"');
    expect(footer).toContain('<Link href="/">Home</Link>');
    expect(footer).toContain("TRADEMARKS.md");
    expect(footer).toContain("THIRD_PARTY_NOTICES.md");
    expect(footer).not.toContain("Local-first · read-only");
    expect(chrome).toContain("padding-inline: max(32px, calc((100% - 1200px) / 2));");
  });

  it("leaves no page on the old paper style", () => {
    for (const file of ["app/download/DownloadPage.module.css", "app/docs/docs.module.css", "app/docs/markdown.module.css", "app/docs/search.module.css"]) {
      const css = read(file);
      expect(css, file).not.toMatch(/Rokkitt|paper-fiber|distress-mask|#f0ece2/i);
      if (!file.includes("search")) expect(css, file).toContain("#0e1012");
    }
    expect(read("app/download/page.tsx")).not.toContain("PaperPage");
  });

  it("repeats the Worker's security headers for the files the assets binding serves", () => {
    const rules = read("public/_headers").replace(/\r\n/g, "\n").split(/\n(?=\S)/).filter((rule) => !rule.startsWith("#"));
    const everyFile = rules.find((rule) => rule.startsWith("/*\n"));
    const sent = (everyFile ?? "").split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
    expect(sent).toEqual(SECURITY_HEADERS.map(([name, value]) => `${name}: ${value}`));
    // vinext adds this rule only when the package ships no _headers file, so the file keeps it.
    expect(rules.map((rule) => rule.trimEnd())).toContain("/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable");
    expect(read("worker/index.ts")).toContain("for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);");
  });
});
