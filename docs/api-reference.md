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
    "last_probed_at": "2026-09-27T00:00:00.000Z"
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

The staleness window:

- The expected probe interval is the longest routine gap the in-process scheduler leaves between two refreshes of the lane: the 5-minute healthy re-probe, the 5-minute `auth_failed` backoff, or the active backoff policy's ceiling for the lane's provider, whichever is longest.
- N is `HEIMDALL_SIGNAL_STALE_MULTIPLIER` (default `3`), so the default window is 15 minutes.
- While a lane is `degraded`/`down`/`out_of_credit` with a known reset time (`manual_reset_at`, else `reset_at`), the scheduler deliberately waits until that time before re-probing. The window then starts at the reset time instead of the last observation.
- Any recorded observation counts, including a passive status push or a reported route outcome.

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

# Route selection
heimdall route --task-type=<type> --task-id=<id> [--estimated-cost=<n>] [--json]

# Outcome reporting
heimdall route-outcome --decision-id=<id> [--outcome=<value>] [--actual-cost=<n>]
```

`task-type` values: `code` | `chat` | `analysis` | `creative` | `other`

The `--json` flag on `heimdall route` writes the chosen lane ID to stdout and the full JSON result to stderr, so scripts can capture just the lane ID cleanly.
