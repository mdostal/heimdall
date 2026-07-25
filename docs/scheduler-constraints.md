# Heimdall Scheduler — hard constraints (feed into `/plan`)

Decision of record: `DEC-hdl-scheduler-backend` (Pantheon decision-log).
Research-first / build-vs-buy scan done 2026-07-25 — see below. This is a **hard
planning input** for the "pluggable per-lane Scheduler (post-P0)" epic. Do NOT
plan a naive global `setInterval`.

## Core principle: PER-LANE

Each lane owns **two** impls, not one shared timer:

1. **A health-check impl** — how *this* lane is checked. Reuses the existing
   layered signal sources (`passive → public-status → active-probe`), but the
   *composition* is per-lane:
   - lane with a public status page (Claude, Codex) → poll the page, sparse probe;
   - local lane (Ollama) → cheap port/`/health` ping, no public page;
   - lane with no status page → passive + sparse active-probe only.
2. **A scheduler impl / cadence** — *when/how often* this lane is refreshed.

`LanePipeline.refresh(lane)` stays UNTOUCHED — the scheduler only decides
*when* to call it, per lane. **Heimdall stays the checker.**

## Scheduler backends (archetypes each lane selects from)

| Backend | Cadence | Role | HARD-LAW |
|---------|---------|------|----------|
| `MulticaAutopilotScheduler` | cron, **≥1 min floor** | **DEFAULT** coarse fleet sweep — `multica autopilot trigger add --kind schedule --cron` fires Heimdall's refresh (CLI/HTTP). Zero new box daemon. | ✅ sanctioned primitive |
| `InProcessScheduler` | ~5 s | Fine SLA corroboration — engaged **only when a lane goes suspect/degraded** (SLA harness needs 2 signals inside a 10 s window; cron can't go sub-minute). Backs off when the lane is healthy. | ✅ = the service's OWN event loop, **not** a standalone cron/launchd/shell daemon |

`Scheduler` is an **interface** so future per-lane strategies (adaptive backoff,
event-driven) drop in without touching `refresh()` or the check impls.

**Banned:** any standalone box cron / launchd / shell-daemon ticker — that is the
`multica-native-no-box-runners` HARD LAW. Multica autopilot = the coarse ticker;
in-process = the service loop only.

## Emit to Argus (observability god) over OTEL

Every tick + every status flip → OTLP to **Argus** (`4327 gRPC / 4328 HTTP`,
→ Langfuse for traces/cost, SigNoz for infra). This:
- satisfies the "every tool logs decisions + metrics" mandate (KPIs are real);
- gives lane-health a dashboard for free — Heimdall builds **no** UI of its own.
Heimdall keeps its SQLite history; Argus receives the stream.

## Build-vs-buy scan result (why this is a *new* build, not a reuse)

- **Argus** = observability (OTEL → Langfuse/SigNoz): "what happened / cost / is
  the box healthy." **Does NOT probe provider lanes** (scan confirmed). No dup.
- **Multica autopilots** = the native cron scheduler (`ComputeNextRun`, 1-min
  floor) → this is the sanctioned coarse ticker, reused here.
- **dostal-swarm monitoring** = Grafana/Prometheus/Claudometer (infra+cost) —
  telemetry, not lane-health.
- Provider-lane liveness ("is the Claude/Codex lane up / down / out-of-credit
  right now") is **unclaimed** — genuinely Heimdall's.
