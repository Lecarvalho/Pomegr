import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SiteFooter } from "../../app/components/SiteFooter";
import { SiteHeader } from "../../app/components/SiteHeader";

const pages = ["home", "about", "docs", "download"] as const;

it("keeps the same header on every page, changing only the current-page indicator", () => {
  const headers = pages.map((current) => renderToStaticMarkup(<SiteHeader current={current} />));
  for (const html of headers) {
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html.replace(' aria-current="page"', "")).toBe(headers[0].replace(' aria-current="page"', ""));
  }
});

it("links to the documentation from the header, between About and the source link", () => {
  for (const current of pages) {
    const html = renderToStaticMarkup(<SiteHeader current={current} />);
    const links = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((match) => [match[1], match[2]]);
    expect(links.filter(([, text]) => text === "Docs")).toEqual([["/docs", "Docs"]]);
    expect(links.map(([href]) => href)).toEqual([
      "/",
      "/about",
      "/docs",
      "https://github.com/Lecarvalho/pomegr",
      "/download",
    ]);
    expect(/<a class="[^"]*"( aria-current="page")? href="\/docs">Docs<\/a>/.test(html)).toBe(true);
    expect(html.includes('aria-current="page" href="/docs">Docs</a>')).toBe(current === "docs");
  }
});

it("keeps the Docs link in the phone header while the other text links hide", () => {
  const css = readFileSync(new URL("../../app/components/SiteChrome.module.css", import.meta.url), "utf8");
  const phone = /@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const nav = /<nav[\s\S]*<\/nav>/.exec(renderToStaticMarkup(<SiteHeader current="home" />))![0];
  const tags = [...nav.matchAll(/<a\s[^>]*?href="([^"]*)"[^>]*>/g)].map((match) => match[0]);
  const tagFor = (href: string) => tags.find((tag) => tag.includes(`href="${href}"`))!;
  const classOf = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1] ?? "";

  // A class, not an href selector, marks the one text link that stays; the download action has its own class.
  expect(classOf(tagFor("/docs"))).toMatch(/phoneLink/);
  expect(classOf(tagFor("/download"))).toMatch(/headerAction/);
  for (const href of ["/", "/about", "https://github.com/Lecarvalho/pomegr"]) expect(classOf(tagFor(href)), href).toBe("");
  expect(phone).toMatch(/\.header nav > a:not\(\.headerAction\):not\(\.phoneLink\)\s*\{\s*display:\s*none;\s*\}/);
  expect(phone).not.toContain("[href");
  expect(css).not.toMatch(/\.phoneLink\s*\{[^}]*display:\s*none/);

  // The nav gap shrinks so brand, Docs, and the download action share one line down to 351 px, where
  // the wordmark hides below; Docs keeps the 44 px target of the shared header link rule.
  expect(phone).toMatch(/\.header nav\s*\{\s*gap:\s*8px;\s*\}/);
  expect(css).toMatch(/\.header nav a,\s*\.footer nav a\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/);
  expect(css).toMatch(/@media \(max-width: 350px\)\s*\{\s*\.header :global\(\.brandWordmark\)\s*\{\s*display:\s*none;/);
});

it("offers the documentation from every footer except the docs pages, and keeps the other footer links", () => {
  const footerLinks = (current: (typeof pages)[number]) =>
    [...renderToStaticMarkup(<SiteFooter current={current} />).matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((match) => match[2]);
  const shared = ["License", "Notices", "Source", "Trademark policy"];

  expect(footerLinks("home")).toEqual(["About", "Docs", ...shared]);
  expect(footerLinks("about")).toEqual(["Home", "Docs", ...shared]);
  expect(footerLinks("download")).toEqual(["Home", "About", "Docs", ...shared]);
  expect(footerLinks("docs")).toEqual(["Home", "About", ...shared]);
  expect(renderToStaticMarkup(<SiteFooter current="home" />)).toContain('href="/docs"');
});
