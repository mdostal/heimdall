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

### Excluding a lane

`task_type_weights` are keyed by provider family, so two lanes of the same
provider (for example two Claude accounts) always score the same. To keep a
lane out of routing entirely, list its id under `excluded_lanes` in
`config/routing-policy.yaml`:

```yaml
excluded_lanes:
  - claude@mathew.dostal
```

- The exclusion is applied to the candidate list before any strategy runs:
  `priority`, `round-robin` and `scored` all see the lane as absent. It wins
  over a manual `enabled` override.
- If the only healthy lane is excluded, the answer is "no route"
  (`chosen_lane: null`, or `404 no_available_route`). Heimdall never falls back
  to the excluded lane.
- Withheld lanes are reported, so an operator can tell "withheld" apart from
  "outscored". `POST /route` returns `excluded_lanes` (always a list), and
  `GET /available-route` includes it when it's non-empty. The scored rationale
  ends with `Withheld by policy excluded_lanes: <ids>.`, and the ledger row
  records them in `request_summary.constraints.excluded_lanes`.
- The field is optional. When the policy file is missing, nothing is excluded
  and `priority`/`round-robin` route as before. When the file exists but fails
  validation, every strategy answers `503 routing_policy_unavailable` rather
  than routing without the exclusions.
- The list is read once per process, like the rest of the policy, so restart
  Heimdall after you change it.

### Levels and the premium floor (heimdall#142, slice 3)

Every model a lane routes to can be bound to a level: `premium`, `standard` or
`economy`. Work classes then say which levels they may run on. The section is
optional. Without `levels` and `work_classes`, routing is exactly as before.

```yaml
levels:
  models:                       # model id -> level
    claude-fable-5-2: premium
    claude-opus-5-5: premium
    claude-sonnet-5-5: standard
    claude-haiku-5-5: economy
  lanes: {}                     # lane id -> level, for a lane whose model has no binding
work_classes:
  planning:
    levels: [premium, standard] # opt-in to a lower level
  summaries:
    levels: [economy]
  migrations:
    levels: [premium]
    code_work: true             # held to the premium floor like build/review
```

- **Bindings come from config only.** A model's level is, most specific first:
  the `tier` the lane declares for that model (`HEIMDALL_LANE_<N>_MODELS`
  `id=premium`, or `models[].tier` in `HEIMDALL_LANES_JSON`), then
  `levels.models`, then `levels.lanes`. A model nothing binds is unbound and
  never treated as premium.
- **Lower levels are opt-in per work class.** A request's work class defaults
  to its task type. A class the policy doesn't list may run on premium only.
- **The premium floor.** `build`, `review`, `release`, `code` and any class
  with `code_work: true` never run below premium. A policy that configures one
  of them with anything other than `[premium]` is invalid. When the task type
  is `build` or `review`, the floor holds even if the caller names a looser
  work class.
- **Queue, never a silent downgrade.** A premium model is unavailable when the
  operator turned it off for the lane, or its `weekly_model:<id>` (or
  account-wide) limit is exhausted. If no lane can serve an allowed level, the
  verdict is `queue` with the earliest known `resets_at` (`null` when no reset
  time is known). Heimdall does not fall back to Sonnet or Haiku.
- **Invalid config blocks routing.** An invalid `levels` / `work_classes`
  section, or a lane `tier` that is not a level, answers
  `503 routing_policy_unavailable` under every strategy, the same as a broken
  `excluded_lanes`.
- **Reported everywhere.** Pass the work class as `work_class` on `POST /route`
  and the MCP `heimdall.route_selection` tool, `?work-class=` on
  `GET /available-route`, or `--work-class` on `heimdall route`. Routes then
  carry `level`, `work_class`, `allowed_levels` and `level_withheld` (lanes
  skipped and why: `level_not_allowed`, `unbound`, `model_disabled`,
  `model_unavailable`). `POST /route` adds `verdict` (`route`, `queue` or
  `no_route`), `resets_at` and `chosen_level`. On a queue,
  `GET /available-route` answers `404` with `verdict: "queue"`, `resets_at`,
  `allowed_levels` and `level_withheld`. The scored rationale and the ledger's
  `request_summary.constraints` record the gate too.
- Before you turn levels on, bind every lane's model. A lane on an unbound
  model (for example the placeholder ids in `.env.example`) can only serve a
  work class once something binds it.

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

If the routing policy file is missing or invalid, Heimdall does **not** fall
back to another strategy. `POST /route`, and `GET /available-route` while the
`scored` strategy is active, answer `503` and keep serving every other
request:

```json
{
  "error": "routing_policy_unavailable",
  "detail": "Failed to load routing policy from /path/to/config/routing-policy.yaml: ENOENT ..."
}
```

Deploy `config/routing-policy.yaml` (or set `HEIMDALL_REPO_ROOT`) to fix it.
The policy is retried on the next request, so no restart is needed. Any other
handler error answers `500 {"error": "internal_error", "detail": ...}`, and
the process stays up.

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
