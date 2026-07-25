# Changelog

## [Unreleased]

### Added

- **`lane-health-status` epic complete (v1/P0).** Health/status detection for Claude and Codex lanes across a layered signal model (passive observation, public status-page piggybacking, sparse active probes), a corroboration policy guarding against provider false-positives, and the `LaneRouterContract` — a synchronous request/response query surface exposed identically over HTTP (`GET /lanes`), CLI (`npm run cli`), and MCP (`heimdall.lanes.list`). SLA-verified: status correctness within 10 seconds of an actual state change (measured, not asserted — see `test/sla-harness/report.md`). `/execute` applied the planned `minor` version bump (`0.1.0` → `0.2.0`) to keep the package version in lockstep with this release.
- **`hdl-scheduler` epic complete.** Pluggable per-lane `Scheduler` interface with two HARD-LAW-compliant backends — `MulticaAutopilotScheduler` (default, coarse cron via the real Multica CLI, ≥1min floor) and `InProcessScheduler` (fine ~5s, suspect-lane only, backs off immediately on recovery). Every tick and status flip emits OTEL to Argus (the first Node/TypeScript OTLP client in Pantheon). Added `POST /lanes/:laneId/refresh` (the trigger endpoint Multica's dispatched agent calls) and a stubbed third interaction mode (`ActuationStub`, future Multica runtime on/off toggling). `src/main.ts` is now the real service entrypoint. See `docs/decisions/DEC-hdl-scheduler-backend.md`. `/execute` applied the planned `minor` version bump (`0.2.0` → `0.3.0`).
