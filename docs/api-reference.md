---
title: API Reference
nav_order: 6
---

# API Reference
{: .no_toc }

Heimdall exposes three query surfaces: **HTTP** (primary), **MCP** (for LLM agents), and **CLI** (for shell scripting and human use).

<details open markdown="block">
  <summary>Table of contents</summary>
  {: .text-delta }
1. TOC
{:toc}
</details>

## HTTP API

Base URL: `http://localhost:4870` (override with `PORT`).

All request/response bodies are JSON. Errors return `{"error":"<message>"}` with an appropriate HTTP status code.

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/healthz` | Liveness check. Always returns `{"status":"ok"}`. |
| `GET` | `/readyz` | Readiness check: are lanes actually being sensed? `200 {"status":"ready"}` or `503 {"status":"degraded","reasons":[...]}` with per-check detail. See [operations](operations.md#health-and-readiness-endpoints). |
| `GET` | `/metrics` | Prometheus-compatible metrics scrape endpoint. |

### Lanes

| Method | Path | Description |
|---|---|---|
| `GET` | `/lanes` | List all lanes with current health state. |
| `POST` | `/lanes` | Add a new lane at runtime. Persists to `.env`. |
| `POST` | `/lanes/:id/refresh` | Trigger an immediate health re-probe. |
| `POST` | `/lanes/:id/override` | Set or clear a manual health override. |
| `POST` | `/lanes/:id/reset-at` | Set or clear the scheduled reset time. |
| `POST` | `/lanes/:id/headroom` | Update the lane's headroom scoring input. |
| `POST` | `/lanes/:id/cost-tier` | Update the lane's cost tier scoring input. |
| `PATCH` | `/lanes/:id` | Passive status push from an external observer: `{ "status": "...", "error"?: "<provider error text>" }`. See [Limits](#limits-heimdall142). |
| `GET` | `/lanes/:id/models` | The lane's models with `enabled` / `available`. 200 `{ lane_id, models }`, 404 `unknown_lane`. See [Lane models](#lane-models-heimdall142). |
| `GET` | `/max-usage` | Max-usage status of every lane: `{ lanes: [{ lane_id, enabled, reason, until, set_at, effective, ineffective_reason, paid_switches, paid_switches_note }] }`. See [routing.md](routing.md#max-usage-per-account-heimdall142-slice-5). |
| `GET` | `/lanes/:id/max-usage` | One lane's max-usage status. 200, 404 `unknown_lane`. |
| `POST` | `/lanes/:id/max-usage` | `{ "enabled": true, "until": "<ISO-8601 with zone>", "reason"?: "..." }` turns max usage on, `{ "enabled": false }` off. 200 `{ lane_id, max_usage }`, 400 `invalid_enabled` / `invalid_until` / `invalid_reason` / `unknown_field` / `not_a_heimdall_switch` (any credits / spend-cap field), 404 `unknown_lane`, 503 `invalid_policy`. Never changes credits or a spend cap. |
| `POST` | `/lanes/:id/models/:model` | Turn one model on or off on this lane: `{ "enabled": true \| false \| null, "until"?: "<ISO-8601 with zone>", "reason"?: "..." }`. `null` returns to auto. 200 `{ lane_id, model }`, 400 `invalid_enabled` / `invalid_until` / `invalid_reason`, 404 `unknown_lane` / `unknown_model`. |
| `POST` | `/lanes/:id/limits/clear` | Remove one recorded limit: `{ "kind": "weekly_model:claude-fable-5-2" }`. 200 with the lane's remaining `limits`, 400 `invalid_kind`, 404 `unknown_lane` / `unknown_limit`. |

#### `GET /lanes` response shape

```json
[
  {
    "lane_id": "claude@primary",
    "provider": "claude",
    "model": "claude-sonnet",
    "status": "up",
    "reset_at": null,
    "reason": null,
    "error_code": null,
    "last_updated": "2026-09-27T00:00:00.000Z",
    "signal_source": "passive",
    "manual_override": "auto",
    "override_reason": null,
    "manual_reset_at": null,
    "manual_headroom": null,
    "manual_cost_tier": null,
    "multica_agent_ids": ["abc123"],
    "credential_configured": true,
    "credential_state": "resolved",
    "signal_state": "fresh",
    "last_probed_at": "2026-09-27T00:00:00.000Z",
    "limits": [
      {
        "lane_id": "claude@primary",
        "kind": "weekly_model:claude-fable-5-2",
        "scope": "model",
        "model": "claude-fable-5-2",
        "state": "exhausted",
        "used_percent": null,
        "resets_at": "2026-11-20T19:00:00.000Z",
        "reason": "You've reached your Fable limit · resets Fri 1pm (America/Chicago)",
        "source": "passive",
        "observed_at": "2026-11-15T15:00:00.000Z"
      }
    ]
  }
]
```

`status` values: `"up"` | `"down"` | `"out_of_credit"` | `"degraded"`

`signal_source` values: `"passive"` | `"public_status"` | `"active_probe"`

`error_code` values: `"rate_limit"` | `"quota_exceeded"` | `"billing_error"` | `"auth_failed"` | `"server_error"` | `"network_error"` | `"unknown"` | `null`

`credential_state` values: `"resolved"` | `"unconfigured"` | `"credential_unavailable"` (PANT-932)

`credential_state` says why `credential_configured` is what it is. `unconfigured` means no credential exists under the lane's `credential_ref`. `credential_unavailable` means the credential source couldn't be reached. With `HEIMDALL_CREDENTIAL_SOURCE=pantheon` that is Pantheon core-api being down or answering 5xx, typically right after a host reboot, when every container restarts at once. Heimdall retries these lanes on its probe ticks (backoff 1s, 2s, 4s … capped at 30s, no deadline), and the lane recovers without a restart once core-api answers. Until then the lane reads `down` with a reason starting `credential_unavailable —`. A lane that is `unconfigured` is not retried.

`signal_state` values: `"never_probed"` | `"fresh"` | `"stale"` (PANT-823)

`signal_state` says whether `status` rests on a recent observation. It is on every lane in `GET /lanes`, the `heimdall.lanes.list` MCP tool and the `heimdall` CLI's JSON output, alongside `last_probed_at`.

| `signal_state` | Meaning | `last_probed_at` |
|---|---|---|
| `never_probed` | No observation has ever been recorded for this lane. `status` is the REQ-07 fallback (`"down"`, reason `unconfigured — no status recorded yet`, `last_updated` 1970-01-01), **not** an observed outage. | `null` |
| `fresh` | The last observation is within the staleness window. `status` is a live reading. | timestamp of the last observation |
| `stale` | The last observation is older than N × the lane's expected probe interval. `status` is the last verdict Heimdall saw, and nothing has confirmed it since. | timestamp of the last observation |

`status` is never changed by `signal_state`, so REQ-07 still holds: every declared lane is reported, and a lane with no signal still reads `down`. **Consumers that act on `down` (e.g. Pantheon's lane reconciler, PANT-763) should act only when `signal_state` is `"fresh"`.** Treat `never_probed` and `stale` as "no signal".

#### Limits (heimdall#142)

A subscription account has several separate limits, and one being exhausted does not mean the others are. `limits` lists the ones Heimdall has observed for the lane. It is on every lane in `GET /lanes`, the `heimdall.lanes.list` MCP tool and the CLI JSON, and the dashboard shows it under the lane's reason.

| Field | Values |
|---|---|
| `kind` | `five_hour` · `weekly_all_models` · `weekly_model:<model id>` · `credits` · `spend_cap` |
| `scope` | `account`, or `model` for `weekly_model:*` |
| `state` | `exhausted` (the provider said so) · `available` · `unknown` |
| `used_percent` | 0–100 when the provider reported it, else `null` (unknown). Never estimated. |
| `resets_at` | The provider's own reset time, else `null` (unknown). An `exhausted` limit whose `resets_at` has passed reads `available`. |
| `source` | `active_probe` · `passive` · `operator` |

Limits come from the Claude probe, reported route outcomes, rotation-controller cap handling, and the optional `error` on `PATCH /lanes/:id`. A message naming one model ("You've reached your Fable limit") records only `weekly_model:<id>` as exhausted and leaves the lane `up` (`error_code: "quota_exceeded"`), because the account still serves its other models. A `PATCH` carrying such an error does not change the lane's status, even if it asks for `out_of_credit`. Model names map to ids through `HEIMDALL_CLAUDE_MODEL_ALIASES` (see `docs/configuration.md`). An account-wide weekly or session limit still sets the lane `out_of_credit`, and also records `weekly_all_models` / `five_hour`.

The staleness window:

- The expected probe interval is the longest routine gap the in-process scheduler leaves between two refreshes of the lane: the 5-minute healthy re-probe, the 5-minute `auth_failed` backoff, or the active backoff policy's ceiling for the lane's provider, whichever is longest.
- N is `HEIMDALL_SIGNAL_STALE_MULTIPLIER` (default `3`), so the default window is 15 minutes.
- While a lane is `degraded`/`down`/`out_of_credit` with a known reset time (`manual_reset_at`, else `reset_at`), the scheduler deliberately waits until that time before re-probing. The window then starts at the reset time instead of the last observation.
- Any recorded observation counts, including a passive status push or a reported route outcome.

#### Lane models (heimdall#142)

Every lane in `GET /lanes` (and `heimdall.lanes.list`) carries `models`: the models it can serve. The list comes from config, never constants: the lane's `HEIMDALL_LANE_<N>_MODELS` / JSON `models` (with `tier`), its own `model`, the provider's enabled catalog models when the lane declares no `models`, and any model a recorded `weekly_model:<id>` limit names.

| Field | Meaning |
|---|---|
| `model_id`, `tier` | `tier` is the operator-configured value, else `null`. Pass-through only. |
| `source` | `lane_config` · `lane_model` · `catalog` · `limit` |
| `enabled` | The operator toggle if set, else the provider-wide catalog flag (`POST /models/:provider/:model`) if the catalog knows the model, else `true`. |
| `manual`, `override_reason`, `override_until` | The lane toggle (`enabled` / `disabled` / `null` = auto), its reason and its expiry. |
| `available` | `false` while an exhausted limit blocks the model: its own `weekly_model:<id>`, or an account-wide `five_hour` / `weekly_all_models`. Turns `true` once `resets_at` passes or the limit is cleared. |
| `blocked_by`, `available_at` | The blocking limit kinds, and the latest of their `resets_at` (`null` if any reset time is unknown). |
| `usable` | `enabled && available` |

"Turn Fable off" is one call: `POST /lanes/:id/models/claude-fable-5-2 { "enabled": false }`, the MCP tool `heimdall.lanes.models.setEnabled`, or the dashboard's per-model On / Off / Auto buttons. An optional `until` makes the toggle time-boxed (the #126 override pattern): after it passes the model returns to auto. Toggles persist in SQLite (`lane_model_toggles`) and survive a restart. This slice only reports: routing and spend do not read these fields yet, and a toggle change does not emit `lane.status_changed` (the dashboard re-polls after a click).

### Status view and operator alerts (heimdall#142, slice 6)

| Method | Path | Description |
|---|---|---|
| `GET` | `/status[?swaps=N]` | One read-only view: per account lane each limit (`kind`, `state`, `used_percent`, `resets_at`), its models (`enabled`, `available`, `level`), the max-usage `mode` with its expiry, `current_swap`, the last `N` swaps (default 10, 1-500; else 400 `invalid_swaps`) and `alerts` (`open`, `recent`). |

No estimates: a percent or reset time the provider did not report reads `"unknown"`. A model's `level` is `"unbound"` when the policy has no `levels` section for it.

When a model at an alert level (`HEIMDALL_ALERT_LEVELS`, default `premium`) becomes unavailable on an enabled lane, Heimdall raises one `premium_unavailable` operator alert for the limit that caused it. The same limit reported again never raises a second alert; it closes itself (`limit_reset`, `limit_cleared` or `limit_available`) and a later exhaustion is a new alert. Each alert carries `choices`:

- `swap`: other usable models at the same level, on this account first (`same_account: true`) then on other lanes;
- `wait`: `until` the limit's `resets_at`, or `"unknown"`;
- `human_reset`: `POST /lanes/:id/limits/clear` with the limit `kind`, once a person has lifted it;
- `credits`: only when the account reports a `credits` limit. Heimdall never turns credits on itself.

Alerts are evaluated on every limit change and every `HEIMDALL_ALERT_EVAL_INTERVAL_MS`, stored in SQLite (`operator_alerts`), recorded as `operator_alert` telemetry, streamed on `GET /events` as `event: operator.alert`, shown as a banner on the dashboard and, when `HEIMDALL_ALERT_WEBHOOK_URL` is set, POSTed there as JSON. The webhook URL is never logged.

### Routing

| Method | Path | Description |
|---|---|---|
| `GET` | `/available-route` | Get a route without recording a decision. |
| `POST` | `/route` | Get a route and record the decision for outcome feedback. |
| `POST` | `/route/:decisionId/outcome` | Report the outcome of a decision. |
| `GET` | `/routing-strategy` | Get current strategy and available options. |
| `POST` | `/routing-strategy` | Change the active strategy. |
| `GET` | `/routing-policy` | Get the routing policy (health state eligibility). |

#### `GET /available-route` query params

| Param | Required | Description |
|---|---|---|
| `task-type` | Yes | `code` \| `chat` \| `analysis` \| `creative` \| `other` |
| `task-id` | Yes | Caller-supplied identifier (used for A/B experiment arm assignment). |
| `estimated-cost` | No | Estimated token cost — informs scored strategy. |

#### `POST /route` request body

```json
{
  "task_id": "my-task-001",
  "task_type": "code",
  "estimated_cost": 1500
}
```

#### `POST /route/:id/outcome` request body

```json
{
  "outcome": "success",
  "actual_cost": 1243
}
```

`outcome` values: `"success"` | `"failure"` | `"timeout"` | `"credit_exhausted"`

### Models

| Method | Path | Description |
|---|---|---|
| `GET` | `/models` | List known models, optionally filtered by provider. |
| `POST` | `/models/refresh` | Refresh the model catalog from provider APIs. |
| `POST` | `/models/:provider/:model` | Enable or disable a specific model. |

### Rotation

| Method | Path | Description |
|---|---|---|
| `GET` | `/rotation/:provider` | Get the active account for a provider. |
| `POST` | `/rotation/:provider/rotate` | Manually trigger rotation to the next account. |

### Backoff policy

| Method | Path | Description |
|---|---|---|
| `GET` | `/backoff-policy` | Get the current backoff policy. |
| `POST` | `/backoff-policy` | Update the backoff policy. |
| `GET` | `/backoff-policy/progressive-level-cap` | Get progressive level cap. |
| `POST` | `/backoff-policy/progressive-level-cap` | Set progressive level cap. |
| `GET` | `/backoff-policy/exponential-multiplier` | Get exponential multiplier. |
| `POST` | `/backoff-policy/exponential-multiplier` | Set exponential multiplier. |
| `GET` | `/backoff-policy/exponential-ceiling-ms` | Get ceiling for exponential backoff. |
| `POST` | `/backoff-policy/exponential-ceiling-ms` | Set ceiling for exponential backoff. |
| `GET` | `/backoff-policy/override/:provider` | Get per-provider backoff override. |
| `POST` | `/backoff-policy/override/:provider` | Set per-provider backoff override. |

### UI / misc

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Dashboard HTML (if the UI build is present). |
| `GET` | `/theme` | Get the current UI theme. |
| `POST` | `/theme` | Set the UI theme (`light` or `dark`). |
| `GET` | `/desktop-icon` | Get registered desktop icon state. |
| `POST` | `/desktop-icon` | Register/update desktop icon. |
| `GET` | `/docs` | List embedded documentation pages. |
| `GET` | `/docs/:page` | Fetch a specific embedded doc page. |

---

## MCP Server

The MCP server exposes Heimdall's routing and lane management as tools callable by LLM agents (Claude Code, Codex, etc.).

Start the MCP server:
```bash
node bin/heimdall-mcp.js
# or via npm script: npm run mcp
```

Register with your harness:
```bash
# Claude Code
claude mcp add heimdall -- node /path/to/heimdall/bin/heimdall-mcp.js

# Or use the built-in setup
npx heimdall agent init
```

### MCP tools

| Tool name | Description |
|---|---|
| `heimdall.lanes.list` | List all lanes with current health state (same shape as `GET /lanes`, including `signal_state`/`last_probed_at`) |
| `heimdall.lanes.override` | Set or clear a manual health override on a lane |
| `heimdall.lanes.setResetAt` | Set or clear a scheduled reset time on a lane |
| `heimdall.lanes.add` | Add a new lane at runtime |
| `heimdall.lanes.models.list` | List one lane's models with `enabled` / `available` (`{ lane_id }`) |
| `heimdall.lanes.maxUsage.get` | Max-usage status per lane, with its credits / spend-cap state (report only) (`{ lane_id? }`) |
| `heimdall.lanes.maxUsage.set` | Turn max usage on until an expiry, or off (`{ lane_id, enabled, until?, reason? }`) |
| `heimdall.lanes.models.setEnabled` | Turn one model on a lane on, off, or back to auto (`{ lane_id, model_id, enabled: true\|false\|null, until?, reason? }`) |
| `heimdall.status` | The slice-6 status view (same shape as `GET /status`): limits, models with level, mode, last swaps and open alerts (`{ swaps? }`) |
| `heimdall.routingStrategy.get` | Get the current strategy and available options |
| `heimdall.routingStrategy.set` | Change the active routing strategy |
| `heimdall.models.list` | List known models (optionally filter by provider) |
| `heimdall.models.refresh` | Refresh the model catalog |
| `heimdall.models.setEnabled` | Enable or disable a specific model |
| `route_selection` | Select the best available lane for a task |
| `heimdall.route.reportOutcome` | Report the outcome of a routed task |

---

## CLI

The `heimdall` CLI surfaces a subset of the HTTP API for shell use.

```bash
# Agent setup — register heimdall as MCP server with detected harnesses
heimdall agent init [--harness <claude|codex>]
heimdall agent status

# Status view: limits, models, mode, last swaps and alerts (JSON, or text with --format table)
heimdall status [--format table]

# Route selection
heimdall route --task-type=<type> --task-id=<id> [--estimated-cost=<n>] [--json]

# Outcome reporting
heimdall route-outcome --decision-id=<id> [--outcome=<value>] [--actual-cost=<n>]
```

`task-type` values: `code` | `chat` | `analysis` | `creative` | `other`

The `--json` flag on `heimdall route` writes the chosen lane ID to stdout and the full JSON result to stderr, so scripts can capture just the lane ID cleanly.
