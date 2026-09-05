import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(source).toContain('id="waitlist"');
    expect(source).toContain("Coming next · iOS and Android");
    expect(source).toContain("Windows x64 · available");
    expect(source).toContain('href={DOWNLOAD_URL}>Download for Windows');
    expect(source).toContain('`${GITHUB_URL}/releases/latest`');
    expect(source).not.toContain("Field release · desktop, iOS, Android");
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/){3,}/);
    expect(source).not.toContain("issues/new");
  });

  it("posts a private email signup and recognizes this browser", () => {
    const source = read("app/components/WaitlistActions.tsx");
    const waitlistLink = read("app/components/WaitlistStatusLink.tsx");
    expect(source).toContain('fetch("/api/waitlist"');
    expect(source).toContain('fetch("/api/waitlist/status"');
    expect(source).toContain('type="email"');
    expect(source).not.toContain("platformFieldset");
    expect(source).not.toContain("platforms:");
    expect(source).toContain('action: "waitlist_signup"');
    expect(source).toContain("__TURNSTILE_SITE_KEY__");
    expect(source).toContain("TURNSTILE_PLACEHOLDER_PATTERN");
    expect(source).toContain("{turnstileConfigured ? (");
    expect(source).toContain('new FormData(event.currentTarget).get("website")');
    expect(source).not.toContain('website: ""');
    expect(source).toContain("You’re on the waitlist.");
    expect(source).not.toContain("github.com");
    expect(waitlistLink).toContain("Join the mobile waitlist");
    expect(waitlistLink).not.toContain("/api/waitlist/status");
    expect(waitlistLink).not.toContain("Check your waitlist ticket");
    expect(waitlistLink).not.toContain("useState");
  });

  it("documents the local boundary and authoritative project links", () => {
    const source = read("app/about/page.tsx");
    const header = read("app/components/SiteHeader.tsx");
    const footer = read("app/components/SiteFooter.tsx");
    const chrome = read("app/components/SiteChrome.module.css");
    expect(source).toContain("A quiet view into");
    expect(source).toContain("observer-principles-signal.webp");
    expect(source).toContain("phone-observer-sketch.webp");
    expect(source).toContain("cat-coffee-sketch.webp");
    expect(source).toContain("boy-on-beetle-sketch.webp");
    expect(source).toContain("pomegranate-board-sketch.webp");
    expect(source).toContain("Local session records");
    expect(source).toContain("Loopback monitor");
    expect(source).toContain("Bounded metadata");
    expect(source).toContain("Raw prompts · responses · commands · credentials · transcripts");
    expect(source).toContain('<SiteHeader current="about" />');
    expect(source).toContain('<SiteFooter current="about" />');
    expect(header).toContain('current: "home" | "about"');
    expect(footer).toContain('current: "home" | "about"');
    expect(footer).toContain('<Link href="/about">About</Link>');
    expect(footer).toContain('<Link href="/">Home</Link>');
    expect(footer).toContain("TRADEMARKS.md");
    expect(footer).toContain("THIRD_PARTY_NOTICES.md");
    expect(footer).not.toContain("Local-first · read-only");
    expect(chrome).toContain("width: min(1500px, calc(100% - 64px))");
  });
});
