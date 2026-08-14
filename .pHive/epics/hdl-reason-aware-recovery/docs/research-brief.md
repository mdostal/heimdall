# Research Brief — hdl-reason-aware-recovery

Source: direct codebase inspection during the 2026-08-12 standalone-deploy smoke test and `docs/decisions/DEC-hdl-reason-aware-recovery.md`, which this brief summarizes for planning purposes (full analysis lives there — not re-derived here).

## Problem

`reason` and `reset_at` are captured correctly at the signal layer and persisted to the state store (`LanePipeline.persistResolved`, `src/core/lane-pipeline.ts:140-163`), and exposed via `GET /lanes` (verified live). But **two downstream consumers ignore them**, defeating the point of capturing them:

1. `InProcessScheduler.poll()` (`src/core/scheduler/in-process-scheduler.ts:86-123`) polls every suspect lane (`degraded`/`down`/`out_of_credit`) on a flat `DEFAULT_INTERVAL_MS = 5_000` regardless of whether `reset_at` gives an exact time the lane is expected to recover. Line 88 reads `current.status` only; `reset_at` is never read.
2. `ControlAdapter.reconcile(lane, status)` (`src/core/actuation/control-adapter.ts:14`) only receives the bare `status: LaneStatusValue` enum — `reason`/`reset_at` never reach the actuation layer, so `MulticaControlAdapter`'s Argus emission (`multica-control-adapter.ts:134-149`) can't record *why* a lane was blocked.

## Existing patterns to follow

- **Corroboration state pattern** (`src/core/lane-pipeline.ts` — `lastRawVerdictByLane: Map<string, Verdict>`): per-lane in-memory state, reset on process restart, accepted tradeoff already established in this codebase (comment at `multica-control-adapter.ts:33` makes the same tradeoff for `AgentState`). Any new reset_at-driven scheduling state should follow the same in-memory-Map-keyed-by-lane_id pattern, not introduce a new persistence layer.
- **`Scheduler` interface** (`src/core/scheduler/scheduler.ts`, 12 lines): minimal `start()`/`stop()` contract. `InProcessScheduler` implements it. Changes should stay within this interface — no new interface needed.
- **Options-object constructor injection** (`InProcessSchedulerOptions`, `MulticaControlAdapterOptions`): every scheduler/adapter takes an options object with injectable `setTimeoutImpl`/`clearTimeoutImpl`/etc. for deterministic testing. Any new behavior must stay test-injectable the same way — this codebase's test suite (187 passing tests) relies on fake timers throughout (`in-process-scheduler.test.ts` already injects `setTimeoutImpl`).
- **HARD LAW compliance** (`docs/decisions/DEC-hdl-scheduler-backend.md`, `.pHive/cross-cutting-concerns.yaml` → `no-box-daemon`): any scheduling change must stay inside the existing `InProcessScheduler` event loop — no new standalone timer/daemon.

## Test infrastructure

`node:test` via `tsx`, co-located `*.test.ts` files. `src/core/scheduler/in-process-scheduler.test.ts` and `src/core/actuation/multica-control-adapter.test.ts` already exist and will need new cases, not new files, for straightforward additions (existing describe blocks to extend). Confirmed via `npm test` (187/187 passing pre-change).

## Cross-cutting concerns applicable

From `.pHive/cross-cutting-concerns.yaml`:
- `documentation` — `DEC-hdl-reason-aware-recovery.md` already documents the design; stories should update it to `Status: Accepted` on completion rather than leaving it `Proposed`.
- `no-box-daemon` — applies to story 1 (scheduler change) — must stay inside `InProcessScheduler`'s existing loop, verified above.
- `argus-otel-emit` (if present in the concerns file — not fully surveyed here, story authors should check) — story 2 touches `MulticaControlAdapter`'s Argus emission path directly.
