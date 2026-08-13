# Research Brief — hdl-lane-override

Source: direct codebase inspection, 2026-08-13 (loop cycle 3, following `hdl-lane-status-ui`).

## Problem

The dashboard (`hdl-lane-status-ui`) is read-only. The standalone `has_ui: true` requirement (`.pHive/project-profile.yaml`, `docs/decisions/DEC-hdl-reason-aware-recovery.md` item 3) also needs manual disable/enable — and per explicit operator direction, this must flow through the **existing `ControlAdapter` path**, not a separate code path: *"Lanes are not supposed to just purely have an override to disable the lane... it is turn on and off at a top level for heimdall to DIRECT through."*

## Existing pattern this must plug into

`MulticaControlAdapter.reconcile(lane, status, context)` (`src/core/actuation/multica-control-adapter.ts:58-65`) computes `desiredEnabled = !SUSPECT_STATUSES.has(status)` purely from the sensed status. A manual override must participate in **this same decision**, not bypass it — otherwise the next automatic tick (every `STATUS_WATCHER_INTERVAL_MS` = 5s, `src/main.ts:43`) would immediately reverse a manual override back to whatever the sensed status implies. The `ReconcileContext` interface (`src/core/actuation/control-adapter.ts`, added by `hdl-reason-aware-recovery`) already threads per-tick context (`reason`, `reset_at`) from the call site (`src/main.ts:176`, which reads `current` from the `StateStore` every tick) through to `reconcile()` — a `manualOverride` field is the natural, minimal-diff extension of that same seam.

## State storage

`StateStore`'s `lanes` table (`src/core/state-store.ts:14-18`) holds per-lane state (`lane_id`, `provider`, `credential_ref`) — a `manual_override` column here is a natural fit alongside those (not historical/append-only like `lane_status_history`, which is the wrong table for a persistent per-lane setting). `upsertLane`'s `ON CONFLICT DO UPDATE` only touches `provider`/`credential_ref` — adding `manual_override` to the `INSERT`/`SCHEMA` without touching that `ON CONFLICT` clause means the frequent re-upserts in `getLaneStatuses` (called every `GET /lanes`) won't clobber a set override.

**Migration note:** this repo has no formal schema-migration system — `CREATE TABLE IF NOT EXISTS` only affects fresh databases. A defensive `ALTER TABLE lanes ADD COLUMN manual_override ...` wrapped in try/catch (ignoring "duplicate column" on already-migrated DBs) is needed for any already-created persisted `HEIMDALL_DB_PATH` files. Low real-world risk today (default is in-memory, no evidence of a real persisted-file deployment yet) but cheap to handle correctly.

## HTTP surface

`src/api/http-server.ts`'s existing mutation pattern is `POST /lanes/:laneId/refresh` (`http-server.ts:95-118`) — regex-matched URL, 404 for unknown lane, structured JSON response. A new `POST /lanes/:laneId/override` follows the identical shape.

## Test infrastructure

`node:test` via `tsx`. Relevant existing test files to extend (not create new): `src/core/state-store.test.ts`, `src/core/actuation/multica-control-adapter.test.ts`, `src/core/actuation/control-adapter.test.ts`, `src/api/http-server.test.ts`.

## Cross-cutting concerns applicable

`documentation` (README's HTTP section gains the new endpoint). `argus-otel-emit` — `MulticaControlAdapter`'s existing Argus emission already carries `laneReason`/`laneResetAt`; worth considering whether an override-driven action should be distinguishable in telemetry from a status-driven one (open question for design-discussion.md).
