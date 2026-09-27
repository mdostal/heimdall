---
title: Routing Strategies
nav_order: 5
---

# Routing Strategies
{: .no_toc }

<details open markdown="block">
  <summary>Table of contents</summary>
  {: .text-delta }
1. TOC
{:toc}
</details>

## Overview

Heimdall uses a *pluggable strategy* to select which lane to route a task to. The strategy is applied only over the healthy lanes (those with `status: "up"` or `"degraded"` when no `up` lanes remain). Unhealthy lanes (`down`, `out_of_credit`) are never candidates.

## Built-in strategies

### `scored` (default)

The scored strategy ranks candidate lanes using a multi-factor score:

- **Headroom** — estimated remaining token budget. Higher is better.
- **Cost tier** — `low` > `medium` > `high` for budget-sensitive tasks; reversed for tasks that benefit from more capable (higher-cost) models.
- **Error rate** — lanes with recent errors are penalized.
- **Experiment arm** — a deterministic A/B split keyed on `task_id` so the same task always goes to the same lane within an experiment window.

The scored strategy also feeds an outcome ledger. Callers can report whether a route succeeded via `POST /route/:decisionId/outcome`, which informs future scoring.

### `priority`

Routes to the lowest-numbered priority value among healthy lanes. Ties are broken by lane declaration order. Configure per-lane priority with `HEIMDALL_LANE_<N>_PRIORITY`.

### `round-robin`

Cycles through healthy lanes in declaration order. Simple and stateless.

### `off`

Disables routing entirely. `GET /available-route` and `POST /route` return no lane. Useful for maintenance windows.

## Viewing and changing strategy

```bash
# Current strategy
curl http://localhost:4870/routing-strategy
# {"strategy":"scored","available":["scored","priority","round-robin","off"]}

# Switch strategy
curl -X POST http://localhost:4870/routing-strategy \
  -H 'Content-Type: application/json' \
  -d '{"strategy":"priority"}'
```

## Routing policy

The routing policy controls which health states are eligible for routing:

```bash
curl http://localhost:4870/routing-policy
```

By default, only `up` lanes are candidates. When no `up` lanes exist, `degraded` lanes are used as fallback.

## Requesting a route

```bash
# GET — simple, no side effects, idempotent
GET /available-route?task-type=code&task-id=my-task-001

# POST — records the decision in the outcome ledger, enables outcome feedback
POST /route
{
  "task_id": "my-task-001",
  "task_type": "code",
  "estimated_cost": 1500
}
```

`task_type` values: `code` | `chat` | `analysis` | `creative` | `other`.

Response:

```json
{
  "ok": true,
  "decision_id": "dec-abc123",
  "chosen_lane": "claude@primary",
  "rationale": "Scored highest: headroom=50000, cost_tier=high, no recent errors",
  "experiment_arm": "A"
}
```

When no healthy lane is available:

```json
{
  "ok": false,
  "chosen_lane": null,
  "rationale": "No healthy lanes available"
}
```

## Reporting outcomes

Feed outcome data back to improve future scoring:

```bash
curl -X POST http://localhost:4870/route/dec-abc123/outcome \
  -H 'Content-Type: application/json' \
  -d '{"outcome":"success","actual_cost":1243}'
```

`outcome` values: `success` | `failure` | `timeout` | `credit_exhausted`.

## MCP surface

| Tool | Description |
|---|---|
| `route_selection` | Select the best available route for a task |
| `heimdall.route.reportOutcome` | Report the result of a routed task |
| `heimdall.routingStrategy.get` | Get the current strategy and available options |
| `heimdall.routingStrategy.set` | Change the active strategy |

## CLI surface

```bash
# Get a route
heimdall route --task-type=code --task-id=my-task-001 [--estimated-cost=1500] [--json]

# Report an outcome
heimdall route-outcome --decision-id=dec-abc123 --outcome=success [--actual-cost=1243]
```

## Writing a custom strategy

All built-in strategies implement a shared `RoutingStrategy` interface from `src/core/routing-strategies/`. To add your own:

1. Create `src/core/routing-strategies/my-strategy.ts` implementing the interface.
2. Register it in `src/core/route-selector.ts`'s strategy registry.
3. It will appear in the `available` list from `GET /routing-strategy`.

Strategies receive the full lane registry, the current state store, and the task request. They must return a `LaneStrategyResult` with `chosen_lane` (or null) and a human-readable `rationale`.
