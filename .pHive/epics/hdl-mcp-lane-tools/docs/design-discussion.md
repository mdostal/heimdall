# Design Discussion — hdl-mcp-lane-tools

## Goal

Close the last open piece of `DEC-hdl-reason-aware-recovery.md` item 3: expose override, reset-at, and add-lane as MCP tools, so an agent (not just a human at the dashboard) can exercise/test these operations through Heimdall. Two stories: extract the HTTP routes' validation logic into shared functions first (matching the pattern `GET /lanes` already established), then build the MCP tools on top of that shared layer.

## No open design question this cycle

Confirmed by inspection (research-brief.md): every operation these tools wrap already has a fully-specified, tested HTTP route. This epic is a mechanical "expose what exists," not a new design surface — consistent with what was flagged to the operator before this cycle started.

## Proposed approach — two stories

**Story 1 (`hdl-mcp-01`) — extract shared mutation functions.**
Pulls the validation + side-effect logic out of `overrideMatch`, `resetAtMatch`, and `POST /lanes`'s inline handlers in `http-server.ts` into three standalone exported functions (mirroring `getLaneStatuses`'s existing role as the one place this logic lives, reused by every surface):

```ts
type SetOverrideResult =
  | { ok: true; lane_id: string; manual_override: ManualOverride }
  | { ok: false; error: "unknown_lane"; lane_id: string }
  | { ok: false; error: "invalid_override_state"; allowed_states: string[] };
function setLaneOverride(registry, store, laneId, rawState: unknown): SetOverrideResult

type SetResetAtResult =
  | { ok: true; lane_id: string; manual_reset_at: string | null }
  | { ok: false; error: "unknown_lane"; lane_id: string }
  | { ok: false; error: "invalid_reset_at"; message: string }
  | { ok: false; error: "reset_at_in_the_past"; message: string };
function setLaneResetAt(registry, store, laneId, rawResetAt: unknown): SetResetAtResult

type AddLaneResult =
  | { ok: true; lane_id: string; credential_ref: string; restart_required: true; restart_command: string }
  | { ok: false; error: "missing_field"; field: string }
  | { ok: false; error: "lane_already_declared"; lane_id: string };
function addLane(registry, store, envFilePath, input: unknown): AddLaneResult
```

The HTTP routes become thin: parse the body, call the shared function, translate the discriminated result into a status code (404/400/409/200/201) exactly as today — **byte-identical response bodies**, this is a refactor, not a behavior change. All existing HTTP tests must pass unmodified (asserting on response shape, not implementation).

**Story 2 (`hdl-mcp-02`) — MCP tools.**
Adds three tools alongside `heimdall.lanes.list`, each a thin wrapper calling story 1's shared functions and shaping the result into MCP's `{content: [{type: "text", text: ...}]}` contract:

- `heimdall.lanes.override` — `{lane_id: string, state: "enabled"|"disabled"|"auto"}`
- `heimdall.lanes.setResetAt` — `{lane_id: string, reset_at: string | null}`
- `heimdall.lanes.add` — `{lane_id: string, provider: string, model: string, token: string}`

**Error shape decision:** on a validation failure (unknown lane, invalid state, etc.), the tool returns the SAME `{ok: false, error: ...}` JSON as a text content block — it does **not** throw. Rationale: `heimdall.lanes.list` (the existing tool) never throws either — REQ-07's whole "down/unconfigured, not a crash" philosophy extends naturally here: an agent calling `heimdall.lanes.override` with a typo'd lane_id should get a structured, parseable answer back, not a thrown MCP protocol error it has to catch differently from every other tool. `createMcpServer`'s dispatch only throws for a genuinely unknown tool name (unchanged from today).

`CallToolRequestSchema`'s single `if (name !== X) throw` becomes a small dispatch table (`Record<string, (args) => ToolResult>`) — four tools reads better as a table than a growing if-chain, and it's the natural shape for adding a fifth tool later without the file's git history looking like repeated `else if` insertions.

## Non-goals (this epic)

- **A `heimdall.lanes.refresh` MCP tool** (wrapping `POST /lanes/:laneId/refresh`) — not requested, and that endpoint already has a dedicated caller (Multica's dispatched autopilot agent, per `hdl-05`'s decision record) that doesn't go through MCP.
- **Auth on the MCP tools** — same reasoning as every other surface in this codebase: local, single-operator tool, no auth anywhere yet.

## Scale assessment

**Small.** Story 1 is a mechanical, behavior-preserving refactor (verified by the full existing test suite passing unmodified). Story 2 is three thin wrappers following an exact existing pattern (`callLanesListTool`). Proceeding directly to stories.

## Risks

- **Refactor regression risk** (story 1) — the real risk in this epic. Mitigated by: the full existing HTTP test suite (assert on response status/body, not implementation) must pass with zero changes, and a manual smoke-test pass identical in spirit to prior epics' end-to-end curl checks.

## Dependencies

Builds on all three mutation routes from `hdl-lane-override` and `hdl-lane-management`.

## Open questions

None.
