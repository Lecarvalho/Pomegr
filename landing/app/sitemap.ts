import type { MetadataRoute } from "next";
import { docsContent } from "./docs/content";
import { SITE_ORIGIN } from "./site-origin";

// The public pages of pomegr.com. The documentation pages come from the same generated content
// revision as the rendered pages and the search index, so the three cannot disagree. `/docs` is
// left out because it only redirects to the first page, and so are `/docs/images/` assets, the
// API, and every unpublished path. No `lastModified`: the content revision carries no timestamp.
const SITE_PAGES = ["/", "/about", "/download"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return [...SITE_PAGES, ...docsContent.pages.map((page) => page.route)].map((route) => ({ url: `${SITE_ORIGIN}${route}` }));
}
