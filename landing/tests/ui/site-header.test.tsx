import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
    expect(html.includes('<a aria-current="page" href="/docs">Docs</a>')).toBe(current === "docs");
  }
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
