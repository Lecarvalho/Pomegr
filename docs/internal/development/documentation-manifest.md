# Documentation publication manifest

> Scope: public page selection, navigation order, routes, links, and images.
> Authority: maintained contract for [docs/site.json](../../site.json) and its
> future consumers. The [style guide](../../STYLE_GUIDE.md) owns Markdown authoring.
> Related code and checks: [maintenance workflow](documentation.md#verify-the-change)
> and [landing package](../../../landing/package.json).

Only explicitly selected public pages and their referenced images may enter the
documentation website. The manifest currently selects no pages: public migration
has not begun. The build-time content loader, renderer, search, and `check:docs`
command remain unimplemented; this contract defines their required behavior.

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
future entry belongs in the `concepts` group's `pages` array, once the file exists:

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

Future build and docs checks must reject invalid input before emitting an
artifact. Cover duplicate routes, missing targets, unlisted links, path escapes,
invalid metadata, and accidental internal references, including through a
mistaken manifest entry. Until those checks exist, follow the
[maintenance checks](documentation.md#verify-the-change) and record manual
validation coverage. Deployment remains governed by
[website operations](../../../landing/OPERATIONS.md#5-release-the-exact-audited-artifact).
