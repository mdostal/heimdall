# Design Discussion — hdl-route-outcome-feedback

## 0. Prelude

Continuing the autonomous loop (operator: "loop doing plan execute until you are
truly out of work"). Item 1 of the backlog surveyed 2026-08-15: `docs/vision.md`
names "callers need an outcome-feedback surface" as an explicit gap.
`RouteLedger.reportOutcome()` exists and is tested but nothing calls it — the
ledger records every routing decision and never learns what actually happened.

## 1. Goal

A caller that received a route from `POST /route` (or CLI `route`/MCP
`route_selection`) can report back what happened — success/failure, actual
cost — closing the loop `RouteLedger` was always designed for.

## 2. Approach

Mirrors this codebase's established shared-function pattern exactly:

- `route-selector.ts`: `reportRouteOutcome(input): {ok: true} | {ok: false, error: "unknown_decision"}`,
  delegating to the same module-level `scoredStrategyForRouteEndpoint`'s ledger
  connection every other scored-route operation already uses (no new
  connection opened). `ScoredStrategy` gains a matching `reportOutcome()`
  delegate, same shape as its existing `getDecisionCounts()`.
- `POST /route/:decisionId/outcome` — body `{outcome?: string, actual_cost?:
  number, metadata?: object}`. 404 `unknown_decision` for a decision id that
  was never recorded (or was recorded against a different ledger instance —
  e.g. a different `HEIMDALL_DB_PATH`), never a crash.
- CLI `route-outcome --decision-id=<id> [--outcome=<value>] [--actual-cost=<n>]`
  and MCP `heimdall.route.reportOutcome` — thin wrappers around the same
  shared function, matching `route_selection`'s existing pattern.

## 3. Scale assessment

Small — one new shared function, one new HTTP route, two thin transport
wrappers, tests. No schema change (routing_outcomes already exists,
unused until now).
