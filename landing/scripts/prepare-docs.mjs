// Validates the docs manifest and public Markdown, then writes the generated content, search index and images inside landing/.
//   node scripts/prepare-docs.mjs          validate, then write generated output
//   node scripts/prepare-docs.mjs --check  validate only; write nothing

import { inspectDocsContent, writePreparedDocs } from "./docs-content.mjs";

const checkOnly = process.argv.includes("--check");
const { content, assets, issues } = inspectDocsContent();

if (issues.length || !content) {
  console.error(`Documentation content is invalid (${issues.length} ${issues.length === 1 ? "issue" : "issues"}):`);
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  if (!checkOnly) writePreparedDocs({ content, assets });
  const summary = `${content.pages.length} pages, ${content.images.length} images, search index, revision ${content.revision.slice(0, 12)}`;
  console.log(`docs content ${checkOnly ? "validated" : "prepared"}: ${summary}`);
}
