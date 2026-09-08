import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import DownloadPage from "../../app/download/page";

afterEach(() => vi.unstubAllGlobals());

it("renders real direct downloads and navigation when release lookup is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const html = renderToStaticMarkup(await DownloadPage());
  expect(html).toContain("Get Pomegr on your");
  expect(html).toContain("Download installer");
  expect(html).toContain("Download portable");
  expect(html).toContain("Pomegr-Setup-0.3.6-x64.exe");
  expect(html).toContain("220.5 MB");
  expect(html).toContain("Pomegr-Portable-0.3.6-x64.exe");
  expect(html).toContain("220.3 MB");
  expect(html).toContain('href="https://github.com/Lecarvalho/Pomegr/releases/download/v0.3.6/');
  expect(html).toContain('aria-current="page"');
  expect(html).not.toContain("releases/latest");
  expect(html).not.toContain("[VERSION]");
  expect(readFileSync(new URL("../../worker/index.ts", import.meta.url), "utf8")).toContain('"/download"');
});
