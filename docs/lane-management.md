---
title: Lane Management
nav_order: 4
---

# Lane Management
{: .no_toc }

<details open markdown="block">
  <summary>Table of contents</summary>
  {: .text-delta }
1. TOC
{:toc}
</details>

## What is a lane?

A *lane* is a `provider × account × runtime` triple — e.g. `claude@mathew.dostal`, `codex`, `gemini-2-pro`. Each lane has its own credential, model, and health state. Heimdall tracks all declared lanes and routes tasks only to healthy ones.

## Declaring lanes

Lanes are declared statically in `.env` via numbered triples. See [Configuration Reference](configuration.md#lane-declaration) for the full field list.

```dotenv
HEIMDALL_LANE_1_ID=claude@primary
HEIMDALL_LANE_1_PROVIDER=claude
HEIMDALL_LANE_1_MODEL=claude-sonnet
HEIMDALL_LANE_1_CREDENTIAL_REF=MY_TOKEN
MY_TOKEN=sk-ant-...
```

You can also add a lane at runtime (without restarting) via the API:

```bash
curl -X POST http://localhost:4870/lanes \
  -H 'Content-Type: application/json' \
  -d '{"lane_id":"gemini@new","provider":"gemini","model":"gemini-2-pro","token":"AIza..."}'
```

This persists the new lane to the `.env` file on disk. **The token is never returned by any API after this call.**

## Health states

Every lane is in exactly one of four states:

| State | Meaning |
|---|---|
| `up` | Healthy — route tasks here. |
| `down` | Unreachable or returning hard errors — do not route. |
| `out_of_credit` | Usage cap hit — do not route until the cap resets. |
| `degraded` | Responding but slower or with elevated error rates — route only as fallback. |

### Signal sources (layered)

Heimdall resolves health from three layered signal sources, checked in order:

1. **`passive`** — observed traffic: errors returned during real task execution bubble up into lane state without a separate probe.
2. **`public_status`** — provider status page: Heimdall polls the provider's machine-readable status feed.
3. **`active_probe`** — cheap real call: a minimal inference call to confirm credentials and service liveness. This is the most expensive signal (spends real inference for Claude Code OAuth tokens — the only credential type with no cheaper validation path).

`signal_source` in the lane status response tells you which source determined the current state.

### Corroboration

A single failure does not immediately flip a lane `down`. Heimdall's corroboration policy requires multiple consistent signals before transitioning to a suspect state. This prevents false positives from transient network hiccups.

See [DEC-hdl-429-corroboration.md](decisions/DEC-hdl-429-corroboration.md) for the policy detail.

## Querying lane status

```bash
# All lanes
curl http://localhost:4870/lanes

# Example response (one lane)
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
    "multica_agent_ids": ["abc123"]
  }
]
```

## Manual overrides

You can force a lane into a specific state, bypassing the sensed health:

```bash
# Force a lane down (e.g. during maintenance)
curl -X POST http://localhost:4870/lanes/claude@primary/override \
  -H 'Content-Type: application/json' \
  -d '{"state":"down","reason":"Scheduled maintenance"}'

# Return to automatic sensing
curl -X POST http://localhost:4870/lanes/claude@primary/override \
  -H 'Content-Type: application/json' \
  -d '{"state":"auto"}'
```

`manual_override` values: `"auto"` (no override) | `"up"` | `"down"` | `"out_of_credit"` | `"degraded"`.

## Recovery timers

When a lane goes `out_of_credit`, Heimdall can schedule an automatic recovery check at a known reset time. Set `reset_at` to let the router know when to re-probe:

```bash
curl -X POST http://localhost:4870/lanes/claude@primary/reset-at \
  -H 'Content-Type: application/json' \
  -d '{"reset_at":"2026-09-28T00:00:00.000Z"}'

# Clear a previously-set reset_at
curl -X POST http://localhost:4870/lanes/claude@primary/reset-at \
  -H 'Content-Type: application/json' \
  -d '{"reset_at":null}'
```

## Manual headroom and cost tier

Override the scoring inputs for a lane without editing `.env`:

```bash
# Adjust headroom (remaining token budget estimate)
curl -X POST http://localhost:4870/lanes/claude@primary/headroom \
  -H 'Content-Type: application/json' \
  -d '{"headroom":5000}'

# Adjust cost tier
curl -X POST http://localhost:4870/lanes/claude@primary/cost-tier \
  -H 'Content-Type: application/json' \
  -d '{"cost_tier":"low"}'
```

## Triggering a manual refresh

Force an immediate health re-probe for a lane:

```bash
curl -X POST http://localhost:4870/lanes/claude@primary/refresh
```

## Account rotation

When two or more lanes share the same provider and one goes `out_of_credit`, the rotation controller automatically promotes the next healthy lane as the active account. Query rotation state:

```bash
curl http://localhost:4870/rotation/claude
# {"ok":true,"active_lane_id":"claude@secondary"}

# Manually trigger rotation
curl -X POST http://localhost:4870/rotation/claude/rotate
```

## MCP surface

All lane management operations are also available as MCP tools when Heimdall is registered as an MCP server:

| Tool | Description |
|---|---|
| `heimdall.lanes.list` | List all lanes with health state |
| `heimdall.lanes.override` | Set or clear a manual override |
| `heimdall.lanes.setResetAt` | Schedule a reset_at time |
| `heimdall.lanes.add` | Add a new lane at runtime |
