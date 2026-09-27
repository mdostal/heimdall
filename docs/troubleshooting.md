---
title: Troubleshooting
nav_order: 8
---

# Troubleshooting
{: .no_toc }

<details open markdown="block">
  <summary>Table of contents</summary>
  {: .text-delta }
1. TOC
{:toc}
</details>

## Service won't start

### "node:sqlite not available"

Heimdall requires **Node.js >= 22.5.0**. Check your version:

```bash
node --version
```

If it's below 22.5.0, upgrade Node.js before proceeding.

### "HEIMDALL_LANE_1_ID is not set" / no lanes loaded

Heimdall loaded no lanes. Check that:
1. `.env` exists in the project root.
2. It's readable by the process user.
3. `HEIMDALL_LANE_1_ID`, `HEIMDALL_LANE_1_PROVIDER`, and `HEIMDALL_LANE_1_CREDENTIAL_REF` are all set.
4. The numbered triples are contiguous — a gap (e.g. `_1_` then `_3_`) stops loading at the gap.

### "Port already in use"

Another process is bound to port 4870. Either stop it or change Heimdall's port:

```bash
PORT=4871 npm start
```

## Lane always `down`

### Check the credential

If the `credential_ref` env var doesn't resolve (the env var it names is missing or empty), the lane will show `down` with `error_code: "auth_failed"`. Verify:

```bash
# Does the var exist?
printenv MY_CLAUDE_TOKEN
```

### Check the provider's status page

Heimdall polls provider status pages. A provider outage will show up here before an active probe confirms it. Check:
- Claude: [status.anthropic.com](https://status.anthropic.com)
- OpenAI/Codex: [status.openai.com](https://status.openai.com)
- Gemini: [status.cloud.google.com](https://status.cloud.google.com)

### Force a manual probe

```bash
curl -X POST http://localhost:4870/lanes/my-lane/refresh
```

The response will include the updated status and, if it's still down, the reason and error code.

## Lane stuck `out_of_credit`

The lane's usage cap was hit. Options:

1. **Wait for the natural reset** — the cap resets on the provider's billing cycle.
2. **Set a `reset_at` time** so Heimdall knows when to re-probe:
   ```bash
   curl -X POST http://localhost:4870/lanes/claude@primary/reset-at \
     -H 'Content-Type: application/json' \
     -d '{"reset_at":"2026-09-28T00:00:00.000Z"}'
   ```
3. **Add another lane** with a fresh account — Heimdall's rotation controller will pick it up automatically.
4. **Force override** while you wait:
   ```bash
   curl -X POST http://localhost:4870/lanes/claude@primary/override \
     -H 'Content-Type: application/json' \
     -d '{"state":"up","reason":"Cap reset confirmed manually"}'
   ```

## No route returned (`chosen_lane: null`)

All lanes are unhealthy or none are declared. Check:

```bash
curl http://localhost:4870/lanes
```

Look for lanes where `status` is `up` or `degraded`. If all are `down`/`out_of_credit`:
- Add a new lane, or
- Manually override one to `up` as a temporary measure.

Also check the routing strategy — if set to `off`, no route is ever returned:

```bash
curl http://localhost:4870/routing-strategy
```

## MCP server not found by Claude/Codex

### Claude Code

```bash
# Check if registered
claude mcp get heimdall

# Re-register
claude mcp remove heimdall 2>/dev/null
claude mcp add heimdall -- node /path/to/heimdall/bin/heimdall-mcp.js
```

The `heimdall agent status` command also checks this:
```bash
npx heimdall agent status
```

### Codex

```bash
codex mcp list | grep heimdall
```

Note: `claude mcp list` health-checks every registered server, which is slow (30+ seconds on a loaded machine). Use `claude mcp get heimdall` for a targeted check.

## Multica autopilot not triggering

Verify:
1. `MULTICA_AUTOPILOT_AGENT` is set and names a real, active agent in your workspace.
2. The agent has permission to call `POST /lanes/:id/refresh` on the Heimdall instance.
3. Heimdall's HTTP server is reachable from the Multica runtime (same host or correct network config).

## Database corruption

If Heimdall fails to start with SQLite errors:

1. Stop the service.
2. Move the corrupted database aside: `mv ~/.local/share/heimdall/heimdall.db ~/.local/share/heimdall/heimdall.db.bak`
3. Restart — a fresh database is created automatically.
4. Re-declare any manual overrides (lane health will be re-sensed on first probe).

## Debug logging

Heimdall does not have a debug flag today. For verbose output, run with `NODE_DEBUG=*`:

```bash
NODE_DEBUG=* node dist/main.js 2>&1 | grep -i heimdall
```

## Known issues

| Issue | Workaround |
|---|---|
| Claude Code OAuth tokens require an active probe (actual inference spend) to validate — there is no cheap liveness check for this credential type. | Minimize active probe frequency; rely on passive signal for Claude Code OAuth lanes. |
| Ollama lanes are liveness-only — `degraded` and `out_of_credit` are not tracked for local inference. | Monitor Ollama separately; use manual overrides when needed. |
| OpenRouter has no machine-readable status page — `public_status` is stubbed to always return `up`. | Rely on `passive` and `active_probe` signals for OpenRouter lanes. |
| Multica direct actuation is not implemented (see [DEC-hdl-multica-disable-contract.md](decisions/DEC-hdl-multica-disable-contract.md)) — `multica_agent_ids` are reported but not acted on by Heimdall itself. | Build a downstream facade that reads `GET /lanes` and calls Multica's control API. |
