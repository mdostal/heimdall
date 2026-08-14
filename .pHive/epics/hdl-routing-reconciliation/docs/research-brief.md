# Research Brief — hdl-routing-reconciliation

## Branch divergence

`origin/main` and `origin/dev` share a merge-base at `5f80115` (2026-08-07). Main sat
nearly frozen for ~6 days while this session shipped 13 epics on it (mistakenly — the
project's actual convention is feature → dev → main-for-release). Meanwhile `dev`
independently shipped an advisory routing layer via raw PAN-ticket PRs, never rebased
onto main's work. `git merge-tree` confirms real content conflicts in 12 files:
`package.json`, `package-lock.json`, `.gitignore`, `README.md`,
`src/api/http-server.ts` (+`.test.ts`), `src/api/mcp-server.ts` (+`.test.ts`),
`src/core/lane-registry.ts`, `src/core/route-selector.ts`, `src/core/state-store.ts`,
`src/main.ts`, `test/sla-harness/report.md`.

Operator decision (see the `routing-reconciliation` artifact, Option B, confirmed
2026-08-13): main's `routing-strategies/` pluggable-selection interface stays canonical.
Dev's scorer/ledger/experiment-arm system becomes a new strategy option ("scored")
implementing that interface, not a replacement for it. Operator's own words: *"i like
the idea of being able to swap the strategies used and possibly even creating new ones
... it will require some refactor to make that work correctly where it is neatly
interfaced and separate different options and we can easily choose the different
strategy ... and that way we can do the scorer and stuff with it as well."*

## Deep comparison findings (full detail in the epic's design-discussion.md §2)

**A. dev's `route-selector.ts` has two unrelated exports**, not one evolved design:
- `getAvailableRoute()` — dev's copy is the *stale pre-strategies* version: no
  `manual_override` gating, no model-catalog substitution, `headroom: true` is a
  literal placeholder. Backs `GET /available-route` on dev. **This is strictly worse
  than main's version** — main's file is the correct base for this function, full stop.
- `RouteSelector` class, `.select()` — the real, tested capability. Wraps
  `PolicyLoader` + `scorer.ts` (weighted candidate ranking) + `experiment-assigner.ts`
  (deterministic A/B arms) + `rationale-generator.ts` (human-readable "why") +
  `RouteLedger` (SQLite, own `DatabaseSync` connection, tables `routing_decisions`/
  `routing_outcomes`, same DB file as `StateStore` — coexists fine, separate
  connection). Backs `POST /route`, CLI `route`, MCP `route_selection` — each call site
  independently re-constructs `PolicyLoader`+`RouteLedger`+`RouteSelector` (copy-pasted
  3×, never factored into a shared function — an opportunity to apply this repo's
  established shared-function pattern when porting).

**B. main's `routing-strategies/` contract is too narrow to carry scored's output.**
`RoutingStrategy.selectRoute(taskType, candidates: Lane[]): Lane | null` — synchronous,
no access to `StateStore`, no way to return rationale/decision-id/experiment-arm/ranked
list. `getAvailableRoute()` on main does override-gating → strategy.selectRoute() →
model-catalog substitution, and is the file every other main-only epic (dashboard,
model-catalog, MCP tools) is already wired against.

**C. `rotation-controller.ts` + `error-parser.ts` are solid but inert.** Depend only on
`LaneRegistry` + `StateStore` (zero schema needs — both unchanged in shape on main).
`error-parser.ts` is a pure function sniffing Claude-specific cap-signal shapes.
`RotationController` is fully unit-tested but **never instantiated in `composeService()`
on either branch** — nothing wraps a live Claude call through `.request()` today.
Porting it forward is new integration work, not just a file move.
`token-registry.ts` is a separate, JSON-file-backed, **orphaned** mechanism — nothing in
the runtime imports it. Not worth porting; superseded conceptually by the existing
`credential_ref`/lane-registry model.

**D. State/schema — zero real conflict.** Main's `state-store.ts` (`lanes` +
`manual_override` column, `lane_status_history`, `settings`, `model_catalog`) is a
strict superset of dev's (`lanes` w/o `manual_override`, `lane_status_history` only).
Adopting main's file wholesale loses nothing dev needs. `Lane` field divergence is
additive, not conflicting: dev has `headroom`/`cost_tier` (env-var driven, defaults
`10000`/`"medium"`), main has `priority` — different fields, no collision, both keep.

**F. Dev's own `dev-assessment.md`** (2026-08-11, 262 passing tests, clean build) names
Auriga/Minerva as the real downstream consumers of `POST /route` — an external contract
this epic should preserve, not just discard in favor of `GET /available-route`.

## Sources

All findings sourced via direct `git show origin/main:<path>` / on-disk reads of
`origin/dev` (this epic's branch is based on `dev`), plus `git merge-tree
origin/main origin/dev` for the conflict list. No web research needed — this is an
internal architecture reconciliation, not a new external integration.
