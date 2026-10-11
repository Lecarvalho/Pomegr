import type { MetadataRoute } from "next";
import { docsContent } from "./docs/content";
import { SITE_ORIGIN } from "./site-origin";

// `/docs` is left out because it only redirects; no `lastModified`, since the content revision carries no timestamp.
const SITE_PAGES = ["/", "/about", "/download"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return [...SITE_PAGES, ...docsContent.pages.map((page) => page.route)].map((route) => ({ url: `${SITE_ORIGIN}${route}` }));
}
