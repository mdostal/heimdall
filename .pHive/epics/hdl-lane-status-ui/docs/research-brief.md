# Research Brief — hdl-lane-status-ui

Source: direct codebase inspection, 2026-08-13 (loop cycle 2, following `hdl-reason-aware-recovery`).

## Problem

`.pHive/project-profile.yaml`'s `has_ui: true` note and `docs/decisions/DEC-hdl-reason-aware-recovery.md`'s deferred item 3 both require a standalone-mode UI for Heimdall — today there is zero UI code (`grep -i "react|vue|svelte|next|vite"` against `package.json` returns nothing, confirmed during the 2026-08-12 standalone smoke test). This epic ships the first vertical slice: a **read-only live lane-status view**. Manual disable/enable, add-lane, and MCP agent-tooling are explicitly deferred to follow-up epics (see design-discussion.md).

## Existing patterns to follow

- **`src/api/http-server.ts`** (129 lines) — plain `node:http` router, no framework: a chain of `if (req.method === X && req.url === Y)` blocks inside `createServer((req, res) => {...})`. `GET /healthz`, `GET /lanes`, `GET /available-route`, `POST /lanes/:laneId/refresh` are the existing routes. A new `GET /` route slots into this same chain — same style, same file (or a small sibling module imported into it, to keep the router itself scannable).
- **`getLaneStatuses(registry, store)`** (`http-server.ts:18-30`) already returns exactly the data a status view needs — `LaneStatus[]` with `lane_id`, `provider`, `status`, `reset_at`, `reason`, `last_updated`, `signal_source`. No new backend query logic needed; the UI is a pure consumer of the existing `GET /lanes` JSON.
- **Zero-dependency ethos.** `package.json` dependencies are exactly `@modelcontextprotocol/sdk` + the OpenTelemetry set — no UI framework, no bundler, no CSS framework. Given `north_star.audience` is "Internal/operator-facing... not a polished public product" and this is a local single-operator tool, the natural fit is a **single self-contained HTML page with inline `<style>`/`<script>`**, served as a plain string from the existing `node:http` server — no build step, no new dependency, consistent with how `README.md`'s architecture diagram already shows "Query surfaces: HTTP · CLI · MCP" as three thin consumers of the same state, not a framework layer.

## Test infrastructure

`node:test` via `tsx`, co-located `*.test.ts`. `src/api/http-server.test.ts` already exists with a pattern for spinning up `createHttpServer(...)` against a fake/seeded `StateStore` and asserting on the raw HTTP response — the new route's test extends this same file/pattern.

## Cross-cutting concerns applicable

From `.pHive/cross-cutting-concerns.yaml`: `documentation` (README's "Query surfaces" section and architecture diagram should gain the new UI surface). `no-box-daemon` and `argus-otel-emit` do not apply — this route serves an existing read model with no new scheduling or actuation.
