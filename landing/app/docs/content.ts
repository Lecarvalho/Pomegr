import generated from "../../generated/docs-content.json";
import type { DocsContent, DocsNavigationGroup, DocsPage } from "../../scripts/docs-content.mjs";

// The generated content is the only documentation input the site bundles. Types come from the
// loader's declaration file only; the loader itself never enters the Worker bundle.
export const docsContent = generated as unknown as DocsContent;

const ROUTE_PREFIX = "/docs/";
const SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pagesByRoute = new Map(docsContent.pages.map((page) => [page.route, page]));

/** The catch-all route segments of a page route: `/docs/concepts/cache-reuse` is `["concepts", "cache-reuse"]`. */
export const slugOf = (route: string): string[] => route.slice(ROUTE_PREFIX.length).split("/");

/**
 * The published page for catch-all route segments, or null. Every segment must be a plain manifest
 * topic, so an encoded slash or dot segment can never alias a page under a second URL.
 */
export function findDocsPage(slug: readonly string[] | undefined): DocsPage | null {
  if (!slug || slug.length === 0 || !slug.every((segment) => SLUG_SEGMENT.test(segment))) return null;
  return pagesByRoute.get(`${ROUTE_PREFIX}${slug.join("/")}`) ?? null;
}

export function findDocsGroup(page: DocsPage): DocsNavigationGroup | null {
  return docsContent.navigation.find((group) => group.id === page.group) ?? null;
}
