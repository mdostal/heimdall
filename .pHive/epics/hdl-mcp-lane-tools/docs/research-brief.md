# Research Brief — hdl-mcp-lane-tools

Source: direct codebase inspection, 2026-08-13 (loop cycle 5, following `hdl-lane-management`).

## Problem

`src/api/mcp-server.ts` exposes exactly one tool, `heimdall.lanes.list`, wrapping the shared `getLaneStatuses()` (already reused identically by `http-server.ts` and `cli.ts` — "no duplicated logic" is an explicit existing test's name). The last piece of `DEC-hdl-reason-aware-recovery.md` item 3 — "expose the same capability as tools for agents to exercise/test through Heimdall" — is unbuilt: override, reset-at, and add-lane all exist as HTTP routes only.

## The gap: HTTP routes don't factor out reusable logic (unlike GET /lanes)

`getLaneStatuses(registry, store)` is a standalone exported function `http-server.ts`'s `GET /lanes` route calls, and so does `mcp-server.ts` and `cli.ts` — one function, three surfaces. The three mutation routes added since (`POST /lanes/:laneId/override`, `POST /lanes/:laneId/reset-at`, `POST /lanes`) do **not** follow this pattern — their validation + side-effect logic is written inline inside each `node:http` route handler in `createHttpServer`, not factored into standalone functions. Adding MCP tools for these operations either means duplicating that validation logic a second time (the exact "duplicated logic" the existing `GET /lanes` test explicitly guards against), or extracting it first — matching the established pattern.

## Existing routes' exact validation rules (to preserve when extracted)

- **Override** (`http-server.ts`, `overrideMatch` block): 404 if `!registry.get(laneId)`; 400 `invalid_json` on unparseable body; 400 `invalid_override_state` if `state` isn't one of `enabled|disabled|auto`; `"auto"` maps to `null`.
- **Reset-at** (`resetAtMatch` block): 404 if `!registry.get(laneId)`; 400 `invalid_json`; `reset_at: null` clears immediately (no further validation); otherwise 400 `invalid_reset_at` if not a string or `Date.parse` fails; 400 `reset_at_in_the_past` if `parsedMs <= Date.now()`.
- **Add-lane** (`POST /lanes` block): 400 `invalid_json`; 400 `missing_field` naming the first missing/empty field among `lane_id`/`provider`/`model`/`token`; 409 `lane_already_declared` if `registry.get(laneId) || laneIdAlreadyDeclared(envFilePath, laneId)`; else derives `credential_ref`, calls `appendLane`, returns `{lane_id, credential_ref, restart_required: true, restart_command: "npm run dev"}`.

## Existing patterns to follow

- **`listLaneToolsDescriptor()` / `callLanesListTool()` split** (`mcp-server.ts`) — descriptor generation separate from tool execution, both unit-testable without a stdio transport. New tools follow the same split.
- **MCP SDK's tool dispatch** (`createMcpServer`'s `CallToolRequestSchema` handler) — a single `if (request.params.name !== X) throw` per tool today (one tool); with 4 tools this becomes a small dispatch table, not a chain of `if`s (readability, not correctness — worth getting right since this file will likely grow further).
- **MCP tool response shape**: `{ content: [{ type: "text", text: JSON.stringify(...) }] }` — matches the existing tool exactly; error cases (e.g. unknown lane) need a decision on whether to `throw` (MCP SDK surfaces this as a tool error to the calling agent) or return a structured `{error: ...}` text payload the agent must parse — see design-discussion.md.

## Test infrastructure

`node:test` via `tsx`. `src/api/mcp-server.test.ts` (69 lines) is the existing file to extend, not create new. `src/api/http-server.test.ts` needs updating too if story 1's refactor changes any exported symbols the tests reference.

## Cross-cutting concerns applicable

`documentation` — README's MCP section (currently just `npm run mcp`) should list all 4 tools once shipped.
