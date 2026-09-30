import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "./site-origin";

// Everything the site publishes may be crawled. Naming nothing else keeps internal paths out of a
// file anyone can read; the Worker's allowlist, not robots.txt, decides what is served.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${SITE_ORIGIN}/sitemap.xml` };
}
