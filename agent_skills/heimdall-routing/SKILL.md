---
name: heimdall-routing
description: Read and change Heimdall's global routing strategy, get a scored route recommendation for a specific task, and report back what actually happened with a routing decision. Use whenever the user asks "which lane should handle this task," wants to switch routing strategy (priority/round-robin/scored/off), or wants to close the loop on a prior routing decision's outcome.
---

# Heimdall Routing

Four MCP tools under the `heimdall` MCP server. Three follow the `heimdall.route*` naming
pattern; **the fourth, `route_selection`, does not** — see the callout below before you go
looking for `heimdall.route.selection`.

## `heimdall.routingStrategy.get` — read the active strategy

No parameters.

```json
{ "tool": "heimdall.routingStrategy.get", "arguments": {} }
```

```json
{ "active": "priority", "available": ["priority", "round-robin", "scored", "off"] }
```

There is exactly one active strategy, global across all lanes (not per-lane, not per-task-type).
Default is `priority`.

## `heimdall.routingStrategy.set` — change the active strategy

| param      | type   | required | notes                                                          |
|------------|--------|----------|------------------------------------------------------------------|
| `strategy` | string | yes      | must be one of the names `heimdall.routingStrategy.get` returned in `available` |

```json
{ "tool": "heimdall.routingStrategy.set", "arguments": { "strategy": "round-robin" } }
```

`strategy: "off"` means Heimdall's `/available-route` HTTP endpoint stops picking a lane
entirely — callers have to fall back to `heimdall.lanes.list` and decide manually. An invalid
name returns `{ "ok": false, "error": "invalid_strategy", "allowed_strategies": [...] }`.

## `route_selection` — get a scored route recommendation ⚠️ naming exception

> **This tool is named `route_selection`, NOT `heimdall.route.selection`.** Every sibling tool
> in this skill set follows the `heimdall.<noun>.<verb>` dotted pattern
> (`heimdall.routingStrategy.get`, `heimdall.route.reportOutcome`, `heimdall.lanes.list`, …) —
> `route_selection` is the one exception, a flat snake_case name with no `heimdall.` prefix and
> no dotted namespace. This is intentional in the current tool surface, not a typo to route
> around — if you go looking for it, look for `route_selection` exactly, not a dotted variant.

| param            | type   | required | notes                                              |
|------------------|--------|----------|------------------------------------------------------|
| `task_id`        | string | yes      | caller-supplied; also the deterministic key used for A/B experiment-arm assignment |
| `task_type`      | string | yes      | one of `planning`, `build`, `review`                 |
| `estimated_cost` | number | no       |                                                        |

```json
{
  "tool": "route_selection",
  "arguments": { "task_id": "story-hdl-ao-04-impl", "task_type": "build", "estimated_cost": 0.42 }
}
```

`route_selection` always scores with the `scored` strategy regardless of whatever
`heimdall.routingStrategy.get` currently reports as active — it's the same contract as
`POST /route`, not affected by `heimdall.routingStrategy.set`. Response:

```json
{
  "decision_id": "dec_01j...",
  "chosen_lane": "claude-primary",
  "ranked_candidates": [{ "laneId": "claude-primary", "score": 0.91 }, { "laneId": "codex-backup", "score": 0.74 }],
  "rationale": "claude-primary: up, lowest recent error rate for build tasks",
  "experiment_arm": "control",
  "policy_version": "v3"
}
```

Save `decision_id` — it's what `heimdall.route.reportOutcome` needs.

## `heimdall.route.reportOutcome` — close the loop on a routing decision

| param         | type   | required | notes                                                        |
|---------------|--------|----------|-----------------------------------------------------------------|
| `decision_id` | string | yes      | the `decision_id` returned by `route_selection`                |
| `outcome`     | string | no       | free-form label, e.g. `"success"` or `"failure"`                |
| `actual_cost` | number | no       |                                                                    |

```json
{
  "tool": "heimdall.route.reportOutcome",
  "arguments": { "decision_id": "dec_01j...", "outcome": "success", "actual_cost": 0.38 }
}
```

An unknown `decision_id` returns `{ "ok": false, "error": "unknown_decision" }` rather than
throwing. Call this after the task actually finishes — it's what powers the scored strategy's
decision ledger, not a fire-and-forget log line.
