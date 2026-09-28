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

Lane status history and telemetry events older than `HEIMDALL_RETENTION_DAYS` (default 30) are pruned at startup and once a day. Each lane's latest status row is kept however old it is. Connections wait up to 5s on another process's write lock (`PRAGMA busy_timeout`), so the server, MCP and CLI can share one DB file.

### Shutdown and limits

`SIGTERM` and `SIGINT` trigger a graceful shutdown: timers, background jobs and event subscriptions stop, the server stops accepting connections, open `GET /events` streams are ended (dashboards reconnect to the next instance), and the server waits up to 10s for other in-flight requests, the DB is closed, and the process exits 0. A second signal during shutdown exits 1 immediately. If the port can't be bound (e.g. `EADDRINUSE`), Heimdall logs the cause and exits 1.

Request bodies are capped at 1 MiB. Larger bodies get `413 {"error":"payload_too_large"}`.

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

Metrics exported:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `heimdall_lanes` | gauge | `provider`, `status` | Declared lanes by current status. |
| `heimdall_probes_total` | counter | `lane`, `provider`, `source`, `result`, `error_code` | One per sensing cycle (`LanePipeline.refresh()`). `source` is the signal the cycle used: `active_probe`, `public_status`, `passive` (a reported route outcome, heimdall#96), or `unconfigured` (no credential, resolved without a probe). `result` is the raw pre-corroboration verdict (`up`/`down`/`out_of_credit`/`degraded`), or `error` when the refresh threw (`error_code="exception"`). `error_code` is the classified error, `unconfigured` for a lane with no credential, or `none`. |
| `heimdall_probe_duration_seconds` | histogram | `lane`, `provider` | Wall-clock duration of each **networked** sensing cycle (`source` `active_probe` or `public_status`). Buckets: 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30s. |
| `heimdall_lane_last_probe_age_seconds` | gauge | `lane` | Seconds since the lane's most recent recorded observation. Read from the state DB, so it survives restarts. **A lane that has never been observed has no sample**, so alert on `absent()` or use `GET /readyz`. |
| `heimdall_lane_status_transitions_total` | counter | `lane`, `from`, `to` | Every status change the pipeline writes. `from="none"` is a lane's first-ever status. A new `down` passes through `degraded` until it is corroborated. |
| `heimdall_scheduler_start_failures_total` | counter | `lane`, `scheduler` | A lane scheduler (`in_process` or `multica_autopilot`) failed to start, or the lane's provider has no adapters (`in_process`). Any non-zero value means that lane is not being sensed as configured. |
| `heimdall_rotation_events_total` | counter | `provider`, `kind` | Account rotation events (`capped`/`rotated`). |
| `heimdall_model_substitutions_total` | counter | `provider` | Declared model substituted for a live, enabled alternative. |
| `heimdall_routing_decisions_total` | counter | `result` | Scored-strategy routing decisions (`lane`/`no_route`). |
| `heimdall_model_catalog_entries` | gauge | `provider`, `enabled` | Model catalog size. |

**Passive route outcomes count as sensing cycles (decision, PANT-824 × heimdall#96).** A reported route outcome that decides a lane's status goes through `refresh()` just like a probe and can change status, so it is counted in `heimdall_probes_total` with `source="passive"`. Leaving it out would make status transitions appear with no matching sensing cycle. Filter with `source!="passive"` for provider-probe volume only. Passive and `unconfigured` cycles do no network I/O and resolve in microseconds, so they are **not** timed in `heimdall_probe_duration_seconds`; timing them would pull the histogram toward zero and hide real probe latency.

Probe, duration, transition and scheduler-failure counters are held in memory and reset when the process restarts (standard Prometheus counter semantics; `rate()`/`increase()` handle the reset). The others are read from the state DB.

`heimdall_actuation_results_total` was **removed** (PANT-824). Every lane's control adapter has been `StubControlAdapter` since hdl-msh-01, and nothing calls `emitActuationResult()`, so it could only ever read zero. The stub's intended actions are logged, not counted. Downstream actuators read what to do from `GET /lanes`.

Suggested alerts:
- `increase(heimdall_scheduler_start_failures_total[1h]) > 0`: a lane isn't being scheduled.
- `heimdall_lane_last_probe_age_seconds > 900`: a lane has gone unobserved for 15 min. A healthy lane is re-probed every 5 min. An `auth_failed` lane backs off to 5 min; one with a known reset time waits until that time.
- `sum by (lane) (rate(heimdall_probes_total{result="error"}[15m])) > 0`: a probe adapter is throwing.

The dashboard's **Telemetry** panel shows a per-lane *Sensing* summary built from these metrics: probes by result, last-probe age, transitions, mean probe duration and scheduler start failures. The raw metrics table sits below it.

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

## Health and readiness endpoints

```bash
GET /healthz
# {"status":"ok"}
```

Liveness only: the process is up and serving HTTP. Use it for restart decisions and the desktop app's sidecar startup check. It always returns 200, even when lanes are unhealthy or sensing is broken.

```bash
GET /readyz
# 200 {"status":"ready","reasons":[],"checks":{...}}
# 503 {"status":"degraded","reasons":["lane codex: multica_autopilot scheduler failed to start — ..."],"checks":{...}}
```

Readiness asks whether Heimdall is actually sensing. It returns `503` with `status: "degraded"` and human-readable `reasons` when any of these checks fail:

| Check | Degraded when |
|---|---|
| `schedulers` | Any lane's scheduler failed to start, or the lane's provider has no adapters. `failed_lanes` names them. |
| `state_db` | A rolled-back test write to the state DB fails (read-only file, locked, disk error). |
| `probe_freshness` | Lanes are declared but **no** lane has been observed within the staleness window (default 15 min, `HEIMDALL_READINESS_STALENESS_MS`), or none has ever been observed. Per-lane staleness is left to `heimdall_lane_last_probe_age_seconds`. |

With no lanes declared, `probe_freshness` passes because there is nothing to sense. Lane *health* (a lane being `down`) never affects readiness; that is reported via `GET /lanes`.

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
