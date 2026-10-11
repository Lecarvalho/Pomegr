import { notFound, redirect } from "next/navigation";
import { docsContent } from "./content";

// Redirects to the manifest's first page, so each page has exactly one URL.
export default function DocsEntryPage() {
  if (!docsContent.entry) notFound();
  redirect(docsContent.entry);
}
