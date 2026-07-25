# Research Brief — Pluggable Per-Lane Scheduler (hdl-scheduler)

## Existing codebase (Heimdall itself)

- `src/core/lane-pipeline.ts` — `LanePipeline.refresh(lane)` is the fully-built, fully-tested (99/99 passing) health-check invocation point. **This epic must not modify its internals** — only decide when/how often it's called, per lane.
- `src/core/lane-registry.ts` — `LaneRegistry` declares lanes (`lane_id`, `provider`, `credential_ref`, resolved `credential`). The scheduler epic needs to iterate `registry.list()` to know which lanes exist.
- `src/core/state-store.ts` — `StateStore.getCurrentStatus(laneId)` is how a scheduler would check whether a lane is currently "suspect/degraded" (to decide whether to engage the fine in-process ticker).
- `test/sla-harness/report.md` — the SLA harness's own finding: down/out_of_credit verdicts need 2 consecutive matching raw signals to corroborate. A scheduler tick interval must be fast enough (≈2-4s, well under the 10s window) for that second signal to land in time — this directly informs the in-process ticker's target cadence (~5s per the constraints doc, consistent with this finding).

## Hard planning inputs (already authored, binding — not proposals)

- **`docs/scheduler-constraints.md`** — the authoritative constraints doc. Full content already loaded into this epic's design-discussion; key points: per-lane (not global) scheduling, two backends (`MulticaAutopilotScheduler` default/coarse, `InProcessScheduler` fine/suspect-lane-only), `refresh()` untouched, Argus OTEL emit mandatory, "no standalone box daemon" HARD LAW.
- **`.pHive/planning/architecture.md`** — "Scheduler (post-P0)" section supersedes the original single-timer plan with the same two-backend shape.
- **`.pHive/cross-cutting-concerns.yaml`** — two new concerns apply to every story in this epic: `no-box-daemon` (HARD LAW gate) and `argus-otel-emit` (every tick/status-flip must emit OTLP to Argus).

## External system findings (verified via direct repo inspection, 2026-07-25)

**Multica** (`/Users/mdostal/Code/multica`, real Go CLI+daemon):
- Real CLI verb: `multica autopilot trigger-add <autopilot-id> --kind schedule --cron "<5-field-cron>" --timezone <tz>` (note: **hyphenated `trigger-add`**, the constraints doc's "trigger add" wording is a minor typo to fix).
- Cron floor is **exactly 1 minute**, standard 5-field cron (no seconds), enforced by `ComputeNextRun` in `server/internal/service/cron.go` using `github.com/robfig/cron/v3`.
- Config schema: `.pHive/multica/autopilots.yaml` (see `plugin-hive/hive/references/multica-autopilots-schema.md`) — `autopilots[]`, each with `name`, `title` (idempotency key), `mode` (`create_issue`|`run_only`), `agent`, `triggers[]` (`kind: schedule|webhook`, `cron`, `label`). Reconciler upserts by `title`, never auto-deletes orphans.
- **Critical shape fact:** an autopilot trigger dispatches an **agent** (`mode: run_only, agent: <name>`), not a bare shell command. This means `MulticaAutopilotScheduler` needs a lightweight dispatched agent/script whose only job is to invoke Heimdall's CLI/HTTP refresh trigger — **this is the open design question raised in this epic's design discussion**, not yet resolved by the operator.

**Argus** (Pantheon's observability god):
- **Remote, not local** — runs on a separate host (Tailscale `100.75.161.82`), not `/Users/mdostal/Code/argus*` (doesn't exist locally).
- Stack: `otelcol-contrib v0.157` + Langfuse (traces/cost, live at `http://100.75.161.82:3088`) + SigNoz (infra, own collector on 4317/18).
- Host-facing OTLP ingestion: **4327 gRPC / 4328 HTTP** — matches the constraints doc exactly.
- **No Node.js/TypeScript OTLP client exists anywhere in Pantheon.** This epic is the first to author one — using the standard `@opentelemetry/*` SDK packages (official OTEL packages, not a Pantheon-specific library), not building OTEL protocol handling from scratch.

**`/Users/mdostal/Code/monitoring`** (older, separate telemetry stack):
- Has `src/patterns/BackoffStrategy.js` — a small, pure, dependency-free delay-calculator (`exponential`/`linear`/`jitter` + `shouldRetry`). Reusable *pattern* (not directly importable — different repo/package) for the in-process ticker's potential backoff behavior when a lane stays healthy (constraints doc: "backs off when the lane is healthy").
- Confirmed **not** Argus, not a scheduler abstraction — just a distinct pre-existing stack. No conflict/overlap with this epic's scope.

**`DEC-hdl-scheduler-backend`** — referenced in three places inside Heimdall's own docs but does not exist anywhere in Pantheon yet. This epic must author it (suggested location: `docs/decisions/DEC-hdl-scheduler-backend.md`, since no Pantheon-wide decisions-directory convention exists to place it elsewhere — `plugin-hive/hive/decisions/` uses numbered filenames, not `DEC-*`, and is plugin-hive's own decision log, not a cross-Pantheon one).

## Validation confidence

Codebase-only + direct filesystem inspection (real repos on this machine, not documentation-only claims) — high confidence on Multica/Argus facts. No context7/web validation needed (no third-party library APIs involved beyond the standard `@opentelemetry/*` SDK, which is well-established and stable).
