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
| `GET` | `/healthz` | Liveness check. Returns `{"ok":true}`. |
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
    "multica_agent_ids": ["abc123"]
  }
]
```

`status` values: `"up"` | `"down"` | `"out_of_credit"` | `"degraded"`

`signal_source` values: `"passive"` | `"public_status"` | `"active_probe"`

`error_code` values: `"rate_limit"` | `"quota_exceeded"` | `"billing_error"` | `"auth_failed"` | `"server_error"` | `"network_error"` | `"unknown"` | `null`

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
| `heimdall.lanes.list` | List all lanes with current health state |
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
