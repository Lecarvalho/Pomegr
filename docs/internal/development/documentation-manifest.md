# Documentation publication manifest

> Scope: public page selection, navigation order, routes, links, and images.
> Authority: maintained contract for [docs/site.json](../../site.json) and its
> consumers. The [style guide](../../STYLE_GUIDE.md) owns Markdown authoring.
> Related code and checks: [maintenance workflow](documentation.md#verify-the-change),
> the [content loader](../../../landing/scripts/docs-content.mjs), its
> [boundary audit](../../../landing/scripts/assert-artifact-boundary.mjs), and the
> [landing package](../../../landing/package.json).

Only explicitly selected public pages and their referenced images may enter the
documentation website. The manifest selects ready public pages in reading order,
starting with the
[introduction to Pomegr](../../public/get-started/introduction.md). The build-time
content loader is implemented (see [Generate the website content](#generate-the-website-content));
the renderer, search, and `check:docs` command remain unimplemented and must follow
this contract.

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
Copy only images referenced by selected pages, preserving their path beneath
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
including through a mistaken manifest entry. `check:docs` (WEB-04) will add the
maintained internal links; until then follow the
[maintenance checks](documentation.md#verify-the-change). Deployment remains
governed by [website operations](../operations/website.md#5-release-the-exact-audited-artifact).

## Generate the website content

The [content loader](../../../landing/scripts/docs-content.mjs) is the only
landing module that reads outside `landing/`, and only `docs/site.json` plus the
pages and images it selects beneath `docs/public/`. The `docs:prepare` script of
the landing package runs it automatically before `dev`, `test`, `typecheck`, and
`build`; `docs:check` validates without writing. It writes two gitignored
outputs: `landing/generated/docs-content.json` and the referenced images under
`landing/public/docs/images/`. The Worker bundles only that JSON and never reads
files. An invalid input stops the command with every problem listed as
`file:line`, and nothing is emitted.

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
content changes. Search and the sitemap must use this same revision.

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

The [loader tests](../../../landing/tests/ui/docs-content.test.ts) and
[boundary tests](../../../landing/tests/ui/docs-boundary.test.ts) cover
manifest, metadata, routes, anchors, links, images, raw HTML, determinism, the
real documentation, hostile paths (including a mistaken manifest entry and
links into internal documentation), junctions, and the audit itself.
