# Agents HTML mockup

Status: approved by the user; retained as the visual reference for the production Agents page. This standalone preview uses synthetic data.

Open `agents-preview.html` directly in a browser. It embeds its font and existing Pomegr mark and has no external assets, dependencies, API calls, storage, or provider access. All records are synthetic.

## Review path

1. Filter Models & work by project, period, and main/delegated scope.
2. Click a model or role-matrix count to inspect the contributing runs. Expand an agent's evidence and dismiss with Close or Escape.
3. Switch to Live agents, filter by state, and search assignments.
4. Use the top-right preview-state selector to inspect first load, refresh, partial coverage, update delay, empty history, and unavailable states. Use the theme button for light mode.

## Design intent

The existing Pomegr visual system is retained. Compact counts lead into a model ranking and role matrix; recorded work and evidence-linked observations follow. Main and delegated agents remain distinguishable. The live roster preserves project/session provenance and latest context snapshots.

The counting proposal is one agent instance per parent session, filtered by its start date. Multiple-model runs and unavailable identities remain separate groups. Model percentages use all selected runs as their denominator; rounded percentages may not sum to 100. Counts describe observed retained evidence, not model performance, spend, or time worked. Production uses the latest reported model per agent because retained snapshots do not establish complete model history. It therefore does not infer multiple-model runs. Observed work counts recorded execution tasks rather than all tool calls. See `docs/METRICS.md` for the implemented counting rules.

## Production boundary

The agreed backend direction is a dedicated cache-only Agents endpoint serving a prebuilt aggregate response. Background derivation reads committed normalized evidence, coalesces changes, and refreshes at most once per minute when relevant evidence changes. GET handlers do no acquisition or aggregation. Preserve last-known-good data, independent revisions, and explicit coverage. Historical retention is bounded and does not imply complete 30/90-day history.

The browser-side fixture calculations are for this mockup only. They are not a proposed production data path. Navigation outside Agents is decorative; session links are represented by inline evidence previews.

## Verification

Checked desktop and mobile layout, project/period/scope filters, matrix drill-down counts, keyboard dismissal and tabs, live search/status filtering, theme switching, and preview readiness states. Browser console had no errors during these checks. The design detector ran in its documented regex fallback because optional parser modules were unavailable; findings were checked against the existing tokens. Production build/tests are out of scope for this standalone artifact.
Independent design review: ship. No material fixes required. The mouse Close action, evidence expansion, and arrow-key tab navigation also passed the final browser check.
