# Research Brief — hdl-lane-management

Source: direct codebase inspection, 2026-08-13 (loop cycle 4, following the operator's design decision on `add-lane-design-options` — see design-discussion.md for the resolved direction).

## Scope

Following the operator's decision (mix leaning on "Option 1" from the design-options artifact, plus explicitly requested additional scope): a lanes-management surface covering add-lane (`.env`-based, local secrets, Portunus deferred), token/config visibility, and manual `reset_at` editing ("change the times"), on top of the already-shipped view (`hdl-lane-status-ui`) and on/off override (`hdl-lane-override`).

## A standing gap this epic depends on

`.env` is **not currently auto-loaded** by any npm script — confirmed during the 2026-08-12 standalone smoke test (flagged then, not yet fixed): no `dotenv` import, no `--env-file` flag anywhere in `package.json`. This matters now specifically because add-lane's flow is "write to `.env`, then restart" — if restart doesn't actually pick up the new line, the feature doesn't work end-to-end. Node's built-in `--env-file` flag (stable since Node 20.6, confirmed working via direct test against this repo's Node 22.12) fixes this with zero new dependencies — a one-line addition per script.

## Existing patterns to build on

- **`.env.example`'s format** — `HEIMDALL_LANE_<N>_{ID,PROVIDER,MODEL,CREDENTIAL_REF}` quadruples, contiguous numbering from 1, `CREDENTIAL_REF` naming a separate env var holding the actual secret. Add-lane must write new lines in exactly this shape.
- **`loadLaneDeclarations()`** (referenced by `buildLaneRegistry`, `src/api/http-server.ts:14-16`) — the existing parser for this format; not modified by this epic (still reads once at boot — this epic writes to the file, it doesn't make reading dynamic).
- **`hdl-lane-override`'s precedent** (just shipped) — a `manual_override` column on `StateStore`'s `lanes` table that wins over the sensed value in a downstream decision, exposed via `GET /lanes`, set via a dedicated `POST /lanes/:laneId/...` route. The "change the times" feature (manual `reset_at`) follows this **exact same shape** — a `manual_reset_at` column, read preferentially by `InProcessScheduler`'s already-shipped (`hdl-reason-aware-recovery`) reset_at-aware delay computation, set via `POST /lanes/:laneId/reset-at`. No new mechanism invented; the same pattern applied a second time.
- **Never exposing raw secrets** — `GET /lanes`/`getLaneStatuses` today never serializes `Lane.credential` (the actual resolved secret) into any API response, only `credential_ref` (the env var *name*) via the registry. Token/config visibility in this epic must preserve that: expose whether a lane's credential resolved (`credential_configured: boolean`), never the value itself.

## Files this epic touches

- `package.json` — `--env-file=.env` on `dev`, `dev:http-only`, `cli`, `mcp` scripts.
- New: `src/core/env-file.ts` — parses `.env` for the next available lane index, appends a new lane's 5 lines (4 declaration lines + the secret line) idempotently and safely (no duplicate `HEIMDALL_LANE_N_ID` values).
- `src/core/state-store.ts` — `manual_reset_at` column (same migration pattern as `manual_override`), get/set methods.
- `src/core/scheduler/in-process-scheduler.ts` — delay computation prefers `manual_reset_at` over the sensed `reset_at` when set.
- `src/api/http-server.ts` — `POST /lanes` (add-lane), `POST /lanes/:laneId/reset-at` (manual reset_at), `GET /lanes` gains `credential_configured` + `manual_reset_at`.
- `src/api/ui/dashboard.ts` — add-lane form, token-configured indicator, editable reset_at control.

## Test infrastructure

`node:test` via `tsx`. New test file needed for `src/core/env-file.ts` (no existing file to extend). All other changes extend already-established test files (`state-store.test.ts`, `in-process-scheduler.test.ts`, `http-server.test.ts`).

## Cross-cutting concerns applicable

`documentation` (README gains the new endpoints + the `--env-file` fix). `no-box-daemon` — not applicable, no new scheduling introduced. `argus-otel-emit` — not applicable, this epic doesn't touch the actuation/telemetry layer (manual `reset_at` is scheduling-only, deliberately not threaded into `ReconcileContext`/Argus, keeping this epic's blast radius separate from `hdl-lane-override`'s).
