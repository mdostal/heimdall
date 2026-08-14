# Design Discussion — hdl-model-catalog-dashboard (slice 2 of 3)

## 0. Prelude

Closes the model-catalog trilogy's remaining piece (slices 1 and 3 already shipped: live
fetch/store/query, and auto-substituting route selection). This slice is pure UI — the
operator can already do everything via `GET`/`POST /models`; this makes it visible and
clickable on the dashboard without curling.

## 1. Goal

The dashboard shows the live model catalog grouped by provider, each model with an
enabled/disabled toggle, plus a "Refresh" button that triggers a live re-fetch from every
configured provider.

## 2. Proposed approach

New `.panel` section, positioned after "Add lane," before the lane table — mirrors the
existing "Routing strategy" panel's exact loading discipline: fetched once on page load, not
on the 5s lane-status poll (a config-browsing/editing surface, not a live status row;
re-rendering checkboxes under an operator's cursor every 5s would be actively annoying, same
reasoning already documented for the routing-strategy panel).

- `loadModelCatalog()` → `GET /models`, renders one small table per provider (model id +
  enabled checkbox), reusing this file's existing table/badge CSS rather than introducing new
  visual language.
- A dedicated `change` listener on the model-catalog root (not the page-wide `#root`
  delegation used for lane rows) toggles a model via `POST /models/:provider/:modelId`,
  matching the lane-override buttons' fetch-then-reconcile pattern.
- A "Refresh" button calls `POST /models/refresh`, shows a result banner (`N models across M
  providers`), then reloads the catalog view — mirrors the add-lane form's
  success/error-banner pattern.
- Empty state ("no models seen yet — click Refresh") when the catalog has never been
  refreshed, consistent with every other empty-state message already in this file.

No backend changes — the HTTP/MCP surface (`GET`/`POST /models`, `POST /models/refresh`)
already shipped in slice 1.

## 3. Scale assessment

**Small.** One file (`dashboard.ts`), no backend changes, no schema changes. Proceeding
directly to a single story.
