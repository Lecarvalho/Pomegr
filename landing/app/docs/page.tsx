import { notFound, redirect } from "next/navigation";
import { docsContent } from "./content";

// `/docs` is the documentation entrypoint. It has no content of its own: it sends the visitor to
// the manifest's first page, so each page has exactly one URL. An empty manifest publishes nothing.
export default function DocsEntryPage() {
  if (!docsContent.entry) notFound();
  redirect(docsContent.entry);
}
