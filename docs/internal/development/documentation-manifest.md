# Documentation publication manifest

> Scope: public page selection, navigation order, routes, links, and images.
> Authority: maintained contract for [docs/site.json](../../site.json) and its
> consumers. The [style guide](../../STYLE_GUIDE.md) owns Markdown authoring.
> Related code and checks: [maintenance workflow](documentation.md#verify-the-change),
> the [content loader](../../../landing/scripts/docs-content.mjs), its
> [boundary audit](../../../landing/scripts/assert-artifact-boundary.mjs), the
> [documentation checker](../../../scripts/check-docs.mjs), and the
> [landing package](../../../landing/package.json).

Only explicitly selected public pages and their referenced images may enter the
documentation website. The manifest selects ready public pages in reading order,
starting with the
[introduction to Pomegr](../../public/get-started/introduction.md). The build-time
content loader, the page renderer, and the `/docs` routes are implemented (see
[Generate the website content](#generate-the-website-content) and
[Serve the pages](#serve-the-pages)); the search index, sitemap, and robots.txt
are implemented too (see [Search, sitemap, and robots](#search-sitemap-and-robots)),
and `npm run check:docs` validates this contract together with the maintained
internal links (see [Check the documentation](#check-the-documentation)).

## Select pages and order navigation

The manifest is plain JSON with exactly these fields; reject unknown fields and
unsupported versions when implementing its loader.

| Field | Contract |
| --- | --- |
| `version` | Integer `1` identifies this format. |
| `groups` | Ordered array of navigation groups. |
| Group `id` | Unique category: `get-started`, `using-pomegr`, `concepts`, or `help`. |
| Group `title` | Non-empty plain-text navigation label. |
| Group `pages` | Ordered array of source-path strings relative to `docs/public/`. |

Each source must be an existing Markdown file named `<group-id>/<topic>.md`, with
a lowercase kebab-case topic. Require forward slashes and exact filename case;
reject absolute paths, dot segments, encoded paths, queries, fragments, and globs.
Every source appears once across the manifest. Page front matter supplies `title`
and `description`; the title also labels its navigation entry. Do not duplicate
page metadata in the manifest.

Group order, then page order, determines navigation and previous/next links.
Empty groups are valid during migration and omitted from rendered navigation.
An empty manifest selects nothing; never fall back to directory discovery. Keep
drafts in active plans and add a page only after its migration and checks pass.
Unlisted pages are excluded even when another page links to them.

## Derive unique routes

Derive each page route by prefixing `/docs/` to its source path without `.md`.
There are no route overrides or aliases in version 1. For example, the following
entry belongs in the `concepts` group's `pages` array:

```json
"concepts/context-and-tokens.md"
```

It selects `docs/public/concepts/context-and-tokens.md` and maps to
`/docs/concepts/context-and-tokens`. Routes have no trailing slash and must be
unique across all groups. `/docs` is reserved for the documentation entrypoint;
`/docs/images/` is reserved for selected assets. A duplicate source or route is a
validation error, never a last-entry-wins override. Renaming a published source
changes its route; account for redirects through the website implementation.

## Resolve links and images

Resolve local Markdown links relative to the containing source page. Require an
explicit `.md` target selected by the same manifest, optionally with an existing
heading fragment; fragment-only links target the current page. Rewrite the file
portion to its derived website route and preserve the validated fragment.
Cross-category `../` links are allowed only when their resolved target remains
inside `docs/public/`. Missing or unselected targets fail validation, rather than
pulling additional content into publication.

Use GitHub-style heading anchors consistently in validation and rendering:
lowercase rendered heading text, remove punctuation, replace spaces with hyphens,
and suffix repeated anchors with `-1`, `-2`, and so on, avoiding prior IDs.
External `https:`, `http:`, and `mailto:` links remain links; never fetch their
content for publication. Reject other schemes, protocol-relative URLs, and
root-relative local documentation links; author local links as Markdown paths.

Images use relative Markdown paths with meaningful alt text and must resolve
inside `docs/public/images/<topic>/`. Version 1 accepts PNG, JPEG (`.jpg` or
`.jpeg`), WebP, and GIF files; export other diagram formats to a supported image.
Images are copied byte for byte, so an image may carry no metadata that could name
a path or user: the loader refuses JPEG XMP, JPEG comments, and any JPEG APPn
segment over 64 bytes (the tiny resolution-only EXIF some tools write passes),
PNG `tEXt`, `iTXt`, `zTXt`, and `eXIf` chunks, and WebP EXIF and XMP chunks,
and refuses a truncated or damaged structure. The audit also scans every image's
bytes as text for home-directory and repository paths. Convert screenshots with
a tool that writes no metadata, as the capture procedure does. Copy only images
referenced by selected pages, preserving their path beneath
`/docs/images/`. Reject remote images, data URLs, missing files, and image URLs
with queries or fragments. Do not copy the whole images directory.

## Enforce the publication boundary

Validate resolved filesystem targets, including symlinks and junctions: selected
pages must remain inside the public root and images inside its image root.
Internal docs, plans, mockups, and arbitrary repository files cannot become
publication inputs through paths, links, or assets. Pages, navigation, search,
and sitemap must use the same validated selection and content revision.

Build and docs checks must reject invalid input before emitting an artifact.
The content loader below covers duplicate routes, missing targets, unlisted
links, path escapes, invalid metadata, and accidental internal references,
including through a mistaken manifest entry: [docs-exclusion tests](../../../landing/tests/ui/docs-exclusion.test.ts)
feed the loader and the prepare step entries that name internal pages, plans, parent
directories, absolute paths, and linked directories, and check that a valid manifest
beside canary content publishes none of it in the pages, images, search index, or
sitemap; [docs-artifact tests](../../../landing/tests/ui/docs-artifact.test.ts) build a
fixture site for real and scan `dist/` for the same canaries. [`npm run check:docs`](#check-the-documentation)
runs the same rules from the repository root and adds the public-tree, public-boundary,
and maintained internal-link checks; it is part of `npm run check`, so `verify:fast`,
`verify`, and the Deploy landing workflow run it. Follow the
[maintenance checks](documentation.md#verify-the-change). Deployment remains
governed by [website operations](../operations/website.md#6-publish-documentation).

## Generate the website content

The [content loader](../../../landing/scripts/docs-content.mjs) is the only
landing module that reads outside `landing/`, and only `docs/site.json` plus the
pages and images it selects beneath `docs/public/`. The `docs:prepare` script of
the landing package runs it automatically before `dev`, `test`, `typecheck`, and
`build`; `docs:check` validates without writing. It writes three gitignored
outputs: `landing/generated/docs-content.json`, the
[search index](#search-sitemap-and-robots) `landing/generated/docs-search.json`
built from that same content, and the referenced images under
`landing/public/docs/images/`. The Worker bundles only the content JSON and
never reads files. An invalid input stops the command with every problem listed
as `file:line`, and nothing is emitted.

- **Files:** Exact-case names; every path component a real directory or regular file (symlinks and junctions rejected); pages at most 256 KiB and images at most 8 MiB; UTF-8 without control or bidirectional-override characters; CRLF read as LF so every checkout agrees; image bytes must match their PNG, JPEG, GIF, or WebP signature.
- **Front matter:** Only single-line `title` (at most 80 characters) and `description` (at most 300), quoted or plain, without `<` or `>`; an unknown or repeated key is an error.
- **Structure:** One `#` title first, equal to `title`; `##` to `####` without skipped levels, never inside a list or blockquote.
- **Markdown:** Only the [supported vocabulary](../../STYLE_GUIDE.md#use-a-small-markdown-vocabulary), read from the `marked` lexer tokens. Raw HTML anywhere (even a prose `<placeholder>`), task lists, strikethrough, horizontal rules, indented code, reference definitions, link or image titles, and fences without a language are errors.
- **Callouts:** A blockquote starting `**Note:**` or `**Caution:**` becomes a callout block; any other leading `**Label:**` is an error.
- **Anchors:** `slugifyHeading` and `createSlugger` in the loader are the one GitHub-style implementation; the renderer and `check:docs` import them. Named character references (`&amp;`, `&copy;`, and a short fixed list) are decoded; unknown names stay literal.
- **Links:** As described above, plus: external links must be `https:`, `http:` without credentials, or `mailto:`; every fragment must match a heading of its target; a link needs visible text.
- **Images:** Alt text of 1 to 600 characters; route `/docs/images/<topic>/<file>`; only referenced files are copied, and stale files in the output directory are deleted.

The generated JSON holds `schema`, `revision`, `entry` (the first page's route,
or `null`), `navigation`, `pages`, and `images`. Each page carries its route,
source, group, title, description, headings (depth, id, plain text), structured
blocks, and previous and next links; its shape is declared in
[docs-content.d.mts](../../../landing/scripts/docs-content.d.mts). The
`revision` is a SHA-256 over the schema version, the manifest's groups and
order, each selected page's normalized Markdown, and each referenced image, so
it is deterministic, carries no timestamp, and changes only when published
content changes. The search index and the sitemap use this same revision.

The [boundary audit](../../../landing/scripts/assert-artifact-boundary.mjs)
(`audit:source`, then `audit:artifact`) enforces the input boundary
independently of the loader:

- No landing source except the loader names a path outside `landing/`, and the
  loader names only `../docs/site.json` and `../docs/public`. Nothing names
  internal, plan, or mockup documentation, and `app`, `server`, and `worker`
  cannot import the filesystem.
- The generated JSON must have the expected shape and routes, and
  `public/docs/` must hold exactly the images it declares, byte for byte;
  `dist/client/docs/images/` must match in the built artifact.
- Generated content is scanned with the artifact's forbidden-text patterns.
  One documented exemption exists: a public page may name the example
  repository path `app/Dashboard.tsx` when it describes a screenshot. Only that
  exact text is ignored, in the generated JSON and, in the artifact, only in
  files that carry the content revision. Any other match fails the audit.
- The generated search index must exist and derive from the generated content:
  the same revision, exactly the published pages in the same order, titles,
  descriptions, and headings identical to the content, a plain-text body of at
  most 2000 characters, no extra fields, at most 128 KiB, and the same
  forbidden-text scan. The built client must carry one complete copy of it as a
  lazy chunk. A static `sitemap.xml` or `robots.txt` in the artifact (none is
  emitted today) may list only the public pages under `https://pomegr.com` and
  must not name a path of its own.

The [loader tests](../../../landing/tests/ui/docs-content.test.ts) and
[boundary tests](../../../landing/tests/ui/docs-boundary.test.ts) cover
manifest, metadata, routes, anchors, links, images, raw HTML, determinism, the
real documentation, hostile paths (including a mistaken manifest entry and
links into internal documentation), junctions, and the audit itself.

## Serve the pages

One catch-all route, `landing/app/docs/[...slug]/page.tsx`, renders every
selected page from the generated content, so no page has a hand-written route.
Its `generateStaticParams` lists exactly the manifest's routes and dynamic
params are off. The [docs layout](../../../landing/app/docs/layout.tsx) draws the
skip link, the grouped sidebar in manifest order with `aria-current` on the
current page, and the reading column; the route adds an outline of the page's
`##` and `###` headings and the previous and next links from the generated
data. Its front-matter title and description become the page title and meta
description, and the route is its canonical URL.

- `/docs` has no content of its own. It redirects (307) to `entry`, and is a
  404 when the manifest selects nothing.
- `/docs/<group>/<topic>` serves a selected page. Only exact manifest topics
  match: a group path, a different case, an extra segment, or an encoded slash is
  not a page.
- Every other `/docs/...` path returns status 404 with the documentation 404
  page, which keeps the sidebar.
- `/docs/images/...` files are the static images the loader copied.
- At 760 px and narrower the sidebar opens from a "Documentation menu" button
  with `aria-expanded` and `aria-controls`; Escape closes it and returns focus
  to the button (a first Escape only clears an active search), and choosing a
  page or a search result closes it and moves focus to the content.
  The outline becomes a collapsed "On this page" disclosure below 1100 px.
- Layout ids start with `docs-` and the route tests assert that no published
  heading slug equals one.

The Worker admits the whole family through `/docs` and the `/docs/` prefix; see
[Domain routes and public boundary](../operations/website.md#3-domain-routes-and-public-boundary).
[Route tests](../../../landing/tests/ui/docs-routes.test.tsx) cover the params,
404s, sidebar, outline, pager, phone menu, and the Worker allowlist.

## Search, sitemap, and robots

Search, the sitemap, and robots.txt derive from the same generated content and
revision as the pages, so they can list nothing the pages do not publish.
Internal documentation, plans, and mockups are never inputs to any of them.

- **Index:** [docs-search.mjs](../../../landing/scripts/docs-search.mjs) builds
  it as a pure function of the prepared content (it reads no file and names no
  path). Each page, in reading order, contributes its route, group title, title,
  description, `##` to `####` headings as `{ id, text }`, and a plain-text body
  of paragraphs, list items, table cells, callouts, and quotes. The body leaves
  out code blocks, image alt text, and the `#` title, and is cut at a word
  boundary after 2000 characters. The index copies the content `revision`; its
  shape is declared in [docs-search.d.mts](../../../landing/scripts/docs-search.d.mts).
  The 17 pages produce about 43 KiB (about 14 KiB gzipped), with a hard bound of
  128 KiB enforced by the audit and the tests.
- **Matching:** [search.ts](../../../landing/app/docs/search.ts) lowercases and
  folds accents, requires every typed word to match the start of a word, and
  ranks by where each word matches (title, then heading, description, body) with
  a bonus for a typed phrase in a title or heading. A one-character word, such as
  the "a" in "Spot a compaction", is not matched (it would match nearly every
  page) but still counts toward the phrase bonus; a query of only such words
  finds nothing. Ties keep reading order. It
  returns at most 8 pages with at most 3 matching headings each, and reports the
  true total. It is deterministic and adds no dependency: prefix matching finds
  the words a visitor reads in a title or heading across 17 short pages. Revisit
  it if typed words stop finding their pages as the documentation grows.
- **Interface:** [DocsSearch.tsx](../../../landing/app/docs/DocsSearch.tsx) sits
  first in the sidebar panel, so it is also inside the phone menu. It is a
  labelled `type="search"` field in a `role="search"` form with a polite status
  region ("3 pages match", "No pages match", "Showing the best 8 of 12
  pages.", or "Type at least 2 letters." when no typed word is long enough to
  match). Results replace the page list while there are any: each shows the
  group, the page title, and up to three matching headings as `route#id` links.
  Tab walks the field and every result, ArrowDown and ArrowUp move between them,
  Enter opens the first result, and Escape clears the query before it closes
  anything else. Choosing a result clears the search, closes the phone menu, and
  moves focus to the page. The index loads on first focus as its own lazy
  chunk, never through the content module, so visitors who do not search
  download nothing; if the load fails the page list stays and the status says
  search is unavailable.
- **Sitemap and robots:** `landing/app/sitemap.ts` and `landing/app/robots.ts` are
  vinext metadata routes (a production `vinext start` probe serves
  `/sitemap.xml` as `application/xml` and `/robots.txt` as `text/plain`, and the
  Worker already admits both paths). The sitemap lists `/`, `/about`,
  `/download`, and the published documentation routes, as absolute URLs on the
  origin in `landing/app/site-origin.ts`, without `lastModified` because the
  revision carries no timestamp. It omits `/docs` (a redirect), `/docs/images/`,
  the API, and every unknown path. robots.txt allows everything and names only
  the sitemap location, so it reveals no internal path.

The [index tests](../../../landing/tests/ui/docs-search-index.test.ts),
[search tests](../../../landing/tests/ui/docs-search.test.tsx), and
[sitemap and robots tests](../../../landing/tests/ui/docs-sitemap-robots.test.ts)
cover the generator, the matching and the keyboard behavior, and the exact route
list, and the boundary tests cover the audit of the generated index.

## Check the documentation

`npm run check:docs` ([check-docs.mjs](../../../scripts/check-docs.mjs), with
[docs-check-links.mjs](../../../scripts/docs-check-links.mjs)) validates the public
pages and the maintained Markdown in one pass. It builds and writes nothing, prints a
summary, and exits 0 when everything passes, 1 on documentation failures, and 2 when it
cannot run. `--json` prints `{ ok, summary, failures }` for tools, and each failure
names its file, line, rule, and message. [Tests](../../../tests/docs-check.test.mjs)
cover a good repository and each rule below.

**One implementation.** The script imports `inspectDocsContent` and `buildSearchIndex`
from `landing/scripts/`, so the website build and the check cannot disagree about the
manifest, front matter, routes, headings, links, anchors, images, alt text, or syntax.
The same loader's `createSlugger` computes the anchors of every maintained page. The
dependency points from the root script into landing and never back:
[.dependency-cruiser.cjs](../../../.dependency-cruiser.cjs) forbids landing from importing
outside `landing/` (`landing-cannot-import-outside-landing`) and lets only
`scripts/check-docs.mjs` import landing (`only-docs-checker-imports-landing`), which
`npm run check:boundaries` enforces. The loader needs landing's own dependencies, so a
missing `npm ci --prefix landing` ends the run with a setup error that names the fix.

| Rule | Fails when |
| --- | --- |
| `public-content` | The loader rejects the manifest or a selected page or image; the message is the loader's, with its `file:line`. |
| `search-index` | The index built from the content exceeds 128 KiB, or does not carry the content revision or list the published pages in order. |
| `unselected-page` | A Markdown file under `docs/public/` is not selected by the manifest (navigation membership). |
| `unreferenced-asset` | A non-Markdown file under `docs/public/` is not an image a selected page references. |
| `public-boundary` | A public page, selected or not, links a path outside `docs/public/` or a non-public documentation page (`docs/internal`, `plans`, `mockups`, `design`, `user-guide`) on GitHub, the same directories the build audit rejects. Internal pages may link public pages. |
| `missing-file`, `missing-image` | A relative link or image target does not exist, with exact case as on GitHub. |
| `missing-anchor` | A `#fragment` matches no heading slug or HTML `id` in its target Markdown file. |
| `empty-alt` | An image, Markdown or raw HTML, has no alt text. |

The link, anchor, image, and alt-text rules run over `docs/**/*.md`, root `*.md`,
`landing/*.md`, and `.agents/skills/**/*.md`, so public pages are covered twice and a
failure there can appear under two rules. Links inside fenced or inline code, front
matter, and HTML comments are not links; external URLs are never fetched. Two locations
are skipped: the exported `docs/internal/plans/ia-redesign/prototype/`, and the gitignored
`.agents/skills/acos/runs/`, whose content exists on one machine only. Add a skipped
prefix to `SKIP_PREFIXES` in the helper only for content that is not maintained
documentation.
