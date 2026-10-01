---
name: show-whats-new
description: Update Pomegr Home's What's new announcement for a release, PR, or latest changes pushed to main, including its dismissal identity and existing tests. Use for release highlights shown inside Pomegr; does not publish or package a desktop release.
---

# Show what's new

Refresh Pomegr's Home announcement with verified, user-facing changes from the
requested release. Reuse the known entrypoints below; investigate the release
content afresh each time. Paths are relative to the active Pomegr checkout.

## Go directly to the owners

| File | Responsibility |
| --- | --- |
| `app/HomeDashboard.tsx` | The `HomeUpdateCard` call supplies `title`, `summary`, `description`, `highlights`, and `illustration`. Edit the announcement copy here. |
| `app/components/home/HomeUpdateIllustration.tsx` | The current announcement's artwork: a static, token-based miniature of the feature. Redraw it for each new announcement. |
| `app/components/home/HomeUpdateIllustration.module.css` | Styles for that artwork. Change with it. |
| `app/hooks/useHomePreferences.ts` | `HOME_UPDATE_ID` identifies which announcement the user dismissed. |
| `tests/ui/dashboard-home.test.tsx` | Existing announcement, dialog, dismissal persistence, focus restoration, and previous-announcement migration tests. |
| `app/components/home/HomeUpdateCard.tsx` | Shared presentation: the Home teaser card (thumbnail, title, summary, See what's new, dismiss) and the modal dialog it opens (illustration, description, highlights, Close, Got it). Usually unchanged. |
| `app/components/home/HomeUpdateCard.module.css` | Card, dialog, and phone bottom-sheet styles. Usually unchanged. |

Read the first five files together. Read the presentation files only when needed
for layout or interaction work. If an owner moved, use a focused search for
`HomeUpdateCard` or `HOME_UPDATE_ID` under `app` and `tests/ui`; avoid rediscovering
the whole repository. Follow the current checkout's `AGENTS.md`.

## Understand this release

- Confirm the checkout, working-tree changes, and requested PR or release range.
  Run Git and GitHub CLI through the host environment as required by this repo.
- For a specified PR, start with `gh pr view <number> --json title,body,headRefName,baseRefName,commits,files`.
  Then inspect the final diff and relevant changed behavior owners or tests.
  A PR description can lag later commits; commit headlines can describe work
  subsequently removed. Neither alone proves the shipped result.
- A PR is optional. Honor an explicit user-selected scope: a PR, commit range,
  selected changes, or all changes since the latest released Pomegr version.
- When no scope is given, either ask what to include or establish the latest
  published Pomegr desktop release as the baseline and state the comparison range.
  For latest changes pushed to main, refresh the remote refs and compare that
  release's verified tag/commit with the current `origin/main` commit. Use release
  metadata to identify the published version; do not assume the package version,
  newest local tag, or latest commit represents a published release. Distinguish
  stable releases from prereleases according to the intended release channel.
- Inspect both the commit history and final tree diff from that release commit to
  the selected target (for example, `git log <release-sha>..<target-sha>` and
  `git diff <release-sha> <target-sha>`). Include direct pushes and merged PRs in
  that range; do not assume the latest PR covers the whole release. Uncommitted
  work and local-only commits are outside a request for changes pushed to main
  unless the user includes them.
- If the release baseline, channel, target, or desired subset cannot be determined
  reliably, ask one concise question about what to include before writing the
  announcement. Do not require the user to supply a PR.
- Identify the main visible improvements and relevant fixes. Use the current
  implementation and canonical contracts to check claims that need clarification;
  do not load unrelated documentation or reuse an earlier announcement as evidence.
- Exclude development-only diagnostics, internal refactors, and reverted or planned
  features from desktop feature claims. Translate supporting backend work into
  concrete user-visible behavior when that behavior is supported.

## Update the announcement

Write the copy for both surfaces:

- `title`: one concise heading, shared by the card and the dialog.
- `summary`: one short line for the Home card, no list of details.
- `description`: one or two sentences on the main benefit, shown in the dialog.
- `highlights`: two or three short standalone sentences for the dialog's list:
  a useful action first, then the limits a reader must know. Each must be unique.

Match actual interface terminology and
explain a useful action when applicable. Preserve distinctions between recorded
facts, estimates, and inferences; avoid unmeasured speed claims, invented release
numbers or dates, billing claims, and unsupported cache-cause explanations.

## Draw the illustration

Every new announcement gets its own artwork in `HomeUpdateIllustration.tsx`; never
leave the previous feature's drawing under new copy. It shows the feature at a
glance in the dialog, and the card scales the same node down as its thumbnail.

- Draw a static miniature of the real surface the announcement is about: read that
  component and its styles first, then mirror its actual structure, labels, glyphs,
  and tones. A panel cropped at the bottom edge reads better than a whole screen.
  When no single surface represents the change, draw a simple token-based graphic
  of the idea instead.
- Build it from JSX and CSS with design tokens only, so it follows light and dark
  themes. No screenshots, raster images, literal colors, or new font sizes.
- Use invented sample data that could not be mistaken for a real session: generic
  agent labels, round clock times. Never read session state, fetch, or copy values
  from the user's sessions, and show nothing the real surface could not show
  (no prompts, commands, paths, or token spend).
- Keep the root 408px wide with `max-width: 100%`; the dialog stage shows about
  208px of its height and clips the rest. The artwork is decorative: the card
  wraps it `aria-hidden` and `inert`, so add no controls, links, or required text.
- If an announcement truly has nothing to draw, omit the `illustration` prop; the
  card and dialog fall back to text only.

## Set the dismissal identity and tests

For a new announcement, change `HOME_UPDATE_ID` to a new bounded semantic identifier,
such as `short-release-theme-v1`. Capture the previous ID before editing. This makes
the new card appear for people who dismissed the previous one, and makes its dialog
open by itself once on their next visit to Home (the same ID is stored as the seen
marker when it opens; afterwards the dialog opens only from the card's button). Keep the existing
storage key and schema; preserve pins, last-viewed navigation, and dismissal focus.
For a correction to the same announcement, retain its ID unless it should reappear.

Update the existing tests' expected heading, the dialog's accessible name and
highlight count, and the persisted current ID. Set the
previous-announcement test's fixture to the actual old ID so it proves the new
announcement appears after the last one was dismissed. Preserve the tests for
reload persistence and navigation preferences. Do not add tests that merely repeat
all the announcement prose.

Keep announcement updates scoped to the first five files above. The same Home source is shipped
in the desktop web bundle; no separate desktop announcement copy is needed. A notes
update does not require a version bump, installer build, release tag, or deployment.
For styling or control changes to the card or dialog themselves, consult `DESIGN.md`
and the applicable UI workflow, and update its Home update paragraph and the
`/design-system` sample together; do not turn routine release copy into a redesign.

## Verify and hand off

- During iteration, use `npx vitest run tests/ui/dashboard-home.test.tsx` if focused
  feedback is useful. Skip a redundant focused run when the full suite is next.
- Follow the current checks in `docs/internal/development/agent-workflow.md` and `AGENTS.md`.
  At creation, this workflow required `npm run verify:fast` and `npm test` for this
  UI change; `npm test` includes the production build. On managed Windows, run the
  build/full test wrapper with escalated permissions for generated plugin bundles.
  Never run `npm run build` alongside `npm test`.
- Inspect the rendered card and the open dialog with actual copy and artwork on
  desktop and phone, in light and dark themes. Check that the thumbnail reads as
  the same artwork and that the illustration is not clipped mid-row awkwardly. Reuse the running local app (normally port 3003); avoid
  restarting services or clearing the user's Home preferences merely to inspect it.
- Review the final diff and run `git diff --check`. Complete applicable pre-push
  verification before an authorized push. Report actual coverage and any failures.
- If the task includes updating an existing PR before merge, commit only the intended
  files and push its confirmed head branch within that authorization. Otherwise
  follow the user's requested Git scope; this skill itself grants no push authority.
  Do not merge the PR or publish the release as part of updating the announcement.
- State the highlights, whether previously dismissed cards will reappear, validation,
  and the commit/PR status when applicable. Leave concurrent unrelated edits intact.
