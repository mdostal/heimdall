# Changelog

## [Unreleased]

### Added

- **`lane-health-status` epic complete (v1/P0).** Health/status detection for Claude and Codex lanes across a layered signal model (passive observation, public status-page piggybacking, sparse active probes), a corroboration policy guarding against provider false-positives, and the `LaneRouterContract` — a synchronous request/response query surface exposed identically over HTTP (`GET /lanes`), CLI (`npm run cli`), and MCP (`heimdall.lanes.list`). SLA-verified: status correctness within 10 seconds of an actual state change (measured, not asserted — see `test/sla-harness/report.md`). `/execute` applied the planned `minor` version bump (`0.1.0` → `0.2.0`) to keep the package version in lockstep with this release.
