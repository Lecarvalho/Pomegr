import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "./site-origin";

// Naming nothing else keeps internal paths out of a public file; the Worker's allowlist decides what is served.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${SITE_ORIGIN}/sitemap.xml` };
}
