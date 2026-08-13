# Design Discussion — hdl-lane-override

## Goal

Manual lane disable/enable, satisfying the standalone `has_ui: true` requirement's "manually disable" clause — routed through the **existing `ControlAdapter` path**, per explicit operator direction (not a new/parallel disable mechanism). Two vertical slices: (1) the backend + HTTP surface that makes override durable and effective, (2) a dashboard control to drive it.

## Why route through `ControlAdapter`, not a separate path

The operator's framing is explicit: Heimdall directs traffic through a single top-level gate (`ControlAdapter.reconcile` → Multica `max_concurrent_tasks` 0/N). A manual override is another **input** to that same gate's decision, not a second gate. Concretely: `MulticaControlAdapter.reconcile`'s `desiredEnabled` computation becomes override-aware —

```
desiredEnabled = context.manualOverride
  ? context.manualOverride === "enabled"
  : !SUSPECT_STATUSES.has(status)
```

When no override is set (the default, `null`), behavior is byte-identical to today — status alone decides. When an override is set, it **wins outright** over the sensed status until explicitly cleared (set back to `null`/`"auto"`) — this is the only design that survives the automatic tick loop (`src/main.ts`'s `statusWatcher`, every 5s) without the next automatic reconcile immediately reversing a manual disable of an otherwise-healthy lane.

## Proposed approach — two slices

**Slice 1 (backend + HTTP) — `hdl-lo-01`:**
- `StateStore` gains a `manual_override` column on the `lanes` table (`'enabled' | 'disabled' | null`, default `null`) plus `setManualOverride`/`getManualOverride` methods. Schema addition handled both in fresh-DB `CREATE TABLE` and defensively via a try/caught `ALTER TABLE` for any already-created persisted DB file.
- `ReconcileContext` (`control-adapter.ts`) gains `manualOverride: "enabled" | "disabled" | null`. `src/main.ts`'s tick loop (already reading `current` from the store every cycle to build `context`) reads the override the same way and passes it through.
- `MulticaControlAdapter.reconcile` and `StubControlAdapter.reconcile` both become override-aware per the formula above. `MulticaControlAdapter`'s Argus emission gains an `overrideActive: boolean` field (extending the existing `laneReason`/`laneResetAt` context fields from `hdl-reason-aware-recovery`) so an override-driven block/allow is distinguishable from a status-driven one in telemetry — resolves the research brief's open question in favor of "yes, distinguish it," consistent with that epic's "say why, not just that" principle.
- `POST /lanes/:laneId/override` with body `{"state": "enabled" | "disabled" | "auto"}` — `"auto"` clears the override back to automatic status-driven behavior. Follows the existing `POST /lanes/:laneId/refresh` route's shape exactly (404 on unknown lane, structured JSON response). Takes effect on the next tick (≤5s later, same latency as the existing suspect-lane cadence) — no need to force an immediate reconcile call from the HTTP handler, keeping this slice's diff minimal.
- `GET /lanes` gains the override state on each lane entry (extending `LaneStatus` or as a sibling field) so slice 2's UI (and any API consumer) can see current override state without a second endpoint.

**Slice 2 (UI) — `hdl-lo-02`:**
- Dashboard (`src/api/ui/dashboard.ts`) gets a per-lane control: buttons or a toggle to set `enabled`/`disabled`/`auto`, calling the slice-1 endpoint. Displays current override state distinctly from sensed status (e.g. an "(manual override)" badge/suffix) so it's never ambiguous whether a lane's current block/allow state came from sensing or an operator decision.

## Non-goals (this epic)

- **Add new lanes via the UI** — still deferred (unchanged from `hdl-lane-status-ui`'s non-goals; the `.env`-persistence question is untouched by this epic).
- **MCP agent-tooling surface for override** — deferred to the dedicated MCP-tooling epic (natural next step once this HTTP surface exists to wrap).
- **Auth/access control on the override endpoint** — this is a local, single-operator tool (`north_star.audience`); the existing `GET /lanes`, `POST /lanes/:laneId/refresh` etc. have no auth either. Out of scope, consistent with the rest of this API surface.

## Scale assessment

**Small.** Slice 1 touches 4 files with small, well-isolated diffs (state-store, control-adapter interface + one implementation + stub, http-server, main.ts's context-building), all following patterns already established in this exact codebase by the immediately-prior epic. Slice 2 touches one file (`dashboard.ts`). No new dependencies, no new architectural decision. Proceeding directly to stories (2, one per slice, `hdl-lo-02` depends on `hdl-lo-01`).

## Risks

- **A stuck override is a footgun** (operator disables a lane, forgets, wonders why it's never routed to) — mitigated by slice 2's explicit "(manual override)" UI indicator, so it's always visible, never silent.
- **Schema migration on an already-persisted DB file** — mitigated by the try/catch `ALTER TABLE` approach noted above; low real-world exposure today since `HEIMDALL_DB_PATH` defaults to in-memory.

## Dependencies

Builds on `ReconcileContext` (`hdl-reason-aware-recovery`, already shipped) and the dashboard (`hdl-lane-status-ui`, already shipped).

## Open questions

None blocking — the research brief's telemetry-distinguishability question is resolved above (yes, via `overrideActive`).
