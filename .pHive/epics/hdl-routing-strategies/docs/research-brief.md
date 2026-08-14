# Research Brief — hdl-routing-strategies

Source: direct codebase inspection, 2026-08-13 (loop cycle 6, following `hdl-mcp-lane-tools`). Design resolved by the operator against `routing-heuristics-design-options` (published artifact) — build round-robin, a heuristic (today's priority list), and an off/pass-through mode, all compartmentalized; fix override to actually gate routing; add a settings UI.

## The two problems, confirmed by reading the actual code

**1. `RUNTIME_PRIORITY` is the only strategy, hard-coded** (`src/core/route-selector.ts:17-21`) — exactly what the north_star's `avoid` clause warns against. `getAvailableRoute` (`route-selector.ts:32-66`) has the ranking logic inlined directly in the function — no seam to plug a second strategy into.

**2. `manual_override` (`hdl-lane-override`) does NOT gate `/available-route`.** `getAvailableRoute`'s candidate filter (`route-selector.ts:46-53`) is:
```ts
const candidates = registry.list()
  .filter((lane) => lane.credential !== null)
  .filter((lane) => statuses.get(lane.lane_id)?.status === "up")
  .sort(...)
```
This reads `store.getAllCurrentStatuses()` — the **sensed** status only. It never calls `store.getManualOverride()`. Concretely: an operator can disable a lane via the dashboard (blocking Multica actuation, per `hdl-lane-override`), but `GET /available-route` would still recommend it if its sensed status happens to be "up" — the override has zero effect on routing today. This is the operator's "block the usage and direct it around" requirement, currently unmet.

## Existing precedent for the override-wins-outright pattern (to reuse, not reinvent)

`MulticaControlAdapter.reconcile()` (`hdl-lane-override`):
```ts
const desiredEnabled = context?.manualOverride != null
  ? context.manualOverride === "enabled"
  : !SUSPECT_STATUSES.has(status);
```
Override, when set, wins outright over the sensed value; unset is byte-identical to before. The same precedence is the right fix for routing candidacy: `override === "disabled"` → never a candidate (regardless of sensed status); `override === "enabled"` → always a candidate (bypasses the sensed-status filter); `override` unset (null) → today's behavior, sensed `status === "up"` alone decides.

## Existing tests that pin current default behavior (must not regress)

`http-server.test.ts`'s `/available-route` tests assert **exact** `deepEqual` response shapes for specific task types against `registryWithRouteLanes()`'s fixture (e.g. `task-type=build` → `codex`, matching `RUNTIME_PRIORITY.build`). Whatever strategy is **active by default** (no explicit configuration) must reproduce these exact picks — i.e., "priority" must be the default active strategy, extracted verbatim from today's `RUNTIME_PRIORITY`, not reordered or reinterpreted.

## Existing state-persistence patterns to follow

`manual_override`/`manual_reset_at` (`hdl-lane-override`, `hdl-lane-management`) both live as columns on `StateStore`'s **per-lane** `lanes` table. The active routing strategy is a **global** setting (not per-lane) — none of the existing per-lane columns fit. No existing generic key-value settings table exists yet; this epic needs to add one (`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`, same defensive-migration-not-required-here since it's a brand new table, `CREATE TABLE IF NOT EXISTS` alone suffices).

## Existing patterns for HTTP + shared functions + UI (hdl-mcp-lane-tools, hdl-lane-management)

- Shared validation function returning a discriminated result (`{ok: true, ...} | {ok: false, error, ...}`), called by the HTTP route — same shape as `setLaneOverride`/`setLaneResetAt`/`addLane`.
- Dashboard settings panels (the "Add lane" panel in `dashboard.ts`) are static HTML blocks with a form/control posting to a new endpoint and refreshing via the existing `poll()` cycle or a dedicated fetch-on-load.

## Test infrastructure

`node:test` via `tsx`. No dedicated `route-selector.test.ts` exists yet — routing behavior is currently tested only indirectly through `http-server.test.ts`'s `/available-route` cases. This epic should add a dedicated `src/core/routing-strategies/*.test.ts` per strategy (direct unit tests, no HTTP server needed) plus extend `http-server.test.ts` and `state-store.test.ts`.

## Cross-cutting concerns applicable

`documentation` — README gains the routing-strategy endpoints and the override-gates-routing behavior change.
