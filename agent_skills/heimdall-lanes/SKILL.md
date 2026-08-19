---
name: heimdall-lanes
description: Inspect and manage Heimdall's AI provider lanes over MCP — list live up/down/out_of_credit/degraded status with override state, force a lane enabled/disabled/back to auto, set or clear a manual recovery timer, and declare a brand-new lane. Use whenever the user asks "what's the status of my lanes," wants to force a lane on or off, wants to tell Heimdall when a rate-limited lane will recover, or wants to add a new provider/model lane.
---

# Heimdall Lanes

Four MCP tools, all registered under the `heimdall` MCP server (`heimdall.lanes.*`). Every
lane operation goes through Heimdall's shared `getLaneStatuses`/`setLaneOverride`/
`setLaneResetAt`/`addLane` core functions — the same functions the dashboard and HTTP API use,
so what you see and change here is exactly what the dashboard shows.

## `heimdall.lanes.list` — read current lane status

No parameters.

```json
{ "tool": "heimdall.lanes.list", "arguments": {} }
```

Returns an array of lane status objects, one per declared lane, each shaped like:

```json
{
  "lane_id": "claude-primary",
  "provider": "claude",
  "status": "up",
  "model": "claude-opus-4-6",
  "credential_ref": "HEIMDALL_LANE_1_TOKEN",
  "credential_configured": true,
  "manual_override": null,
  "override_reason": null,
  "manual_reset_at": null,
  "priority": null
}
```

`status` is one of `up`, `down`, `out_of_credit`, `degraded`. `manual_override` is `null`
unless an operator or agent has forced it with `heimdall.lanes.override`.

## `heimdall.lanes.override` — force a lane enabled/disabled, or clear the override

| param     | type   | required | notes                                                                 |
|-----------|--------|----------|------------------------------------------------------------------------|
| `lane_id` | string | yes      | must match a declared lane's `lane_id`                                |
| `state`   | string | yes      | one of `enabled`, `disabled`, `auto`                                   |
| `reason`  | string | no       | free-text note; ignored (never persisted) when `state` is `auto`       |

`auto` clears the override entirely and returns the lane to sensed-status-driven routing — it
does not mean "force enabled."

```json
{
  "tool": "heimdall.lanes.override",
  "arguments": { "lane_id": "claude-primary", "state": "disabled", "reason": "rotating credential" }
}
```

```json
{ "tool": "heimdall.lanes.override", "arguments": { "lane_id": "claude-primary", "state": "auto" } }
```

Unknown `lane_id` or an invalid `state` value returns `{ "ok": false, "error": "unknown_lane" | "invalid_override_state", ... }` rather than throwing — always check `ok` in the response.

## `heimdall.lanes.setResetAt` — set or clear a manual recovery timer

| param       | type            | required | notes                                                                 |
|-------------|-----------------|----------|------------------------------------------------------------------------|
| `lane_id`   | string          | yes      | must match a declared lane's `lane_id`                                |
| `reset_at`  | string or null  | yes      | ISO-8601 timestamp in the future, or `null` to clear a manual value    |

A manually-set `reset_at` wins over whatever Heimdall's automatic sensing would otherwise
compute for when to next check the lane. `reset_at` in the past is rejected
(`{ "ok": false, "error": "reset_at_in_the_past" }`).

```json
{
  "tool": "heimdall.lanes.setResetAt",
  "arguments": { "lane_id": "kimi-backup", "reset_at": "2026-08-19T09:00:00Z" }
}
```

```json
{ "tool": "heimdall.lanes.setResetAt", "arguments": { "lane_id": "kimi-backup", "reset_at": null } }
```

## `heimdall.lanes.add` — declare a new lane

| param      | type   | required | notes                                                |
|------------|--------|----------|--------------------------------------------------------|
| `lane_id`  | string | yes      | must not already be declared                           |
| `provider` | string | yes      | e.g. `claude`, `codex`, `gemini`, `kimi`, `openrouter`  |
| `model`    | string | yes      | the model this lane should use                         |
| `token`    | string | yes      | the lane's credential — written to `.env`, never echoed back or returned by any Heimdall API |

```json
{
  "tool": "heimdall.lanes.add",
  "arguments": {
    "lane_id": "gemini-overflow",
    "provider": "gemini",
    "model": "gemini-2.5-pro",
    "token": "***"
  }
}
```

**Important — this does NOT hot-restart Heimdall.** The new lane is written to the local
`.env` file but is inert until Heimdall restarts. A successful response includes
`restart_required: true` and the exact `restart_command` to run (e.g. `npm run dev`) — surface
that to the user/operator rather than assuming the lane is immediately live.

Duplicate `lane_id` (already declared, or already present in `.env`) returns
`{ "ok": false, "error": "lane_already_declared", "lane_id": ... }`.
