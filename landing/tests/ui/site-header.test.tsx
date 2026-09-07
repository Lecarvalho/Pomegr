import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SiteHeader } from "../../app/components/SiteHeader";

it("keeps the same header on every page, changing only the current-page indicator", () => {
  const pages = ["home", "about", "download"] as const;
  const headers = pages.map((current) => renderToStaticMarkup(<SiteHeader current={current} />));
  for (const html of headers) {
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html.replace(' aria-current="page"', "")).toBe(headers[0].replace(' aria-current="page"', ""));
  }
});
