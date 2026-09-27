---
title: Operations Guide
nav_order: 7
has_children: true
---

# Operations Guide
{: .no_toc }

<details open markdown="block">
  <summary>Table of contents</summary>
  {: .text-delta }
1. TOC
{:toc}
</details>

## Running in production

### Build

```bash
npm run build       # compiles TypeScript to dist/
npm start           # runs dist/main.js
```

### Environment

Heimdall reads only environment variables — no runtime config file. Put your production `.env` outside the repo directory and source it before starting:

```bash
set -a && source /etc/heimdall/prod.env && set +a
node dist/main.js
```

### Process management

Use your OS's supervisor. Example systemd unit:

```ini
[Unit]
Description=Heimdall lane gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/heimdall
EnvironmentFile=/etc/heimdall/prod.env
ExecStart=/usr/bin/node /opt/heimdall/dist/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Port

Default: `4870`. Override with `PORT=<n>` in the environment. Heimdall binds to `0.0.0.0` by default — firewall appropriately in production.

### State store

State persists to SQLite at `HEIMDALL_DB_PATH` (default: `~/.local/share/heimdall/heimdall.db`). Back this up before upgrades. The store holds lane health history, manual overrides, routing decisions, and outcome records.

To reset all state: stop the service, delete the `.db` file, and restart.

## Logging

Heimdall writes structured log lines to stdout. In production, pipe to your log aggregator:

```bash
node dist/main.js 2>&1 | tee /var/log/heimdall/heimdall.log
```

Key log events:
- Lane status transitions (`lane up`, `lane down`, `out_of_credit`, `degraded`)
- Routing decisions (`route selected: <lane_id>`)
- Probe completions (`active_probe completed`)
- Actuation events (`multica_agent disabled/enabled`)

## Metrics endpoint

```bash
GET /metrics
```

Returns Prometheus-compatible text metrics. Scrape this endpoint with Prometheus or Grafana Alloy.

Key metrics:
- `heimdall_lane_status` — gauge per lane (1=up, 0=down)
- `heimdall_route_decisions_total` — counter by lane and task_type
- `heimdall_probe_duration_seconds` — histogram of probe latencies
- `heimdall_outcome_reported_total` — counter by outcome value

## Argus / OTEL telemetry

Heimdall emits spans and metrics to an OTEL collector endpoint (Argus or any compatible collector). Configure via `ARGUS_OTLP_*` env vars. If no collector is reachable, telemetry is silently dropped — the service continues operating.

See [Configuration Reference](configuration.md#argus--otel-telemetry) for the full env var list.

## Multica autopilot integration

Probe scheduling lives inside Heimdall by default: the in-process scheduler probes every never-probed lane at startup, re-probes suspect lanes every ~5s (with backoff), and refreshes healthy lanes periodically. No Multica configuration is needed for lanes to report real status.

Multica-autopilot scheduling is **opt-in** (PANT-753): set `MULTICA_AUTOPILOT_AGENT` and Heimdall additionally registers a coarse-cron autopilot per lane; when it fires, Multica dispatches that agent to call `POST /lanes/:id/refresh`. Each firing is a full agent (LLM) session, so this spends subscription quota on health checks — only enable it if you want that trade-off.

Lane status changes are reported to downstream consumers (like Auriga / Pantheon's control plane) via `GET /lanes` — Heimdall reports `multica_agent_ids` per lane so the facade knows which agents to enable/disable. **Heimdall itself no longer actuates Multica directly** (see [DEC-hdl-multica-disable-contract.md](decisions/DEC-hdl-multica-disable-contract.md) for the rationale).

## Backoff policy

Heimdall applies backoff when re-probing suspect lanes to avoid hammering a provider that is already struggling.

Default policy: **progressive** (increases probe interval up to a configurable level cap). Tune via:

```bash
# View current policy
curl http://localhost:4870/backoff-policy

# Set exponential ceiling to 5 minutes
curl -X POST http://localhost:4870/backoff-policy/exponential-ceiling-ms \
  -H 'Content-Type: application/json' \
  -d '{"value":300000}'
```

Per-provider overrides are also supported (`/backoff-policy/override/:provider`).

## Health check endpoint

```bash
GET /healthz
# {"ok":true}
```

Use this as your load balancer or container orchestrator health check. Heimdall returns 200 even when some lanes are unhealthy — the service itself is alive; lane health is reported separately via `GET /lanes`.

## Dashboard UI

If the UI build is present (`app/dist/`), Heimdall serves a web dashboard at `GET /`. Open `http://localhost:4870` in a browser to see lane status, routing decisions, and telemetry at a glance.

## Token rotation setup

For multi-account rotation (e.g. two Claude API accounts), run the token registry setup script once:

```bash
./scripts/setup-token-registry.sh
```

This creates `~/.heimdall/token-registry.json` (chmod 600) with the primary and secondary tokens. See [ops/token-rotation-setup.md](ops/token-rotation-setup.md) for the full procedure.

## Upgrading

1. Pull the latest release: `git pull && npm install && npm run build`
2. Review the [CHANGELOG.md](../CHANGELOG.md) for breaking changes.
3. Back up `HEIMDALL_DB_PATH` before restarting.
4. Restart the service.

Schema migrations run automatically on startup.
