# Heimdall

[![Build Status](https://img.shields.io/github/actions/workflow/status/mdostal/heimdall/ci.yml?branch=main)](https://github.com/mdostal/heimdall/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OSS Ready](https://img.shields.io/badge/OSS-Ready-brightgreen.svg)]()

**The health-aware lane gateway for [Pantheon](https://github.com/mdostal/pantheon-v2).**

Heimdall watches every LLM/runtime *lane* — a `provider × account × runtime`
triple like `claude@mathew.dostal`, `codex`, or `gemini-3-pro` — reports whether
each one is **up, down, out of credit, or degraded**, and actuates on that signal
by disabling or re-enabling a lane's mapped Multica agents.

📖 **[Read the Documentation Site](https://mdostal.github.io/heimdall/)**

## What & why

Agent fleets stall for boring reasons: one account hits its weekly cap while
others sit idle, or a runtime silently breaks (the classic codex OAuth hang) and
keeps accepting work it can't finish. A `--version` check is not proof a lane is
alive; only a real signal is. Heimdall exists as its own service so that this
sensing-and-actuation loop lives in **one** place with **one** contract, instead
of being re-implemented ad hoc inside every orchestrator, script, and daemon.

Today Heimdall is the **gateway plus advisory-router half** of that vision: it
*senses* lane health from layered signals, *actuates* by toggling Multica agent
concurrency, and can already answer "given this task, which healthy lane should
I use?" through the policy-backed route selector. The next routing work is
dispatch hardening: real headroom/cost inputs, a stable handoff contract, and
outcome feedback (see [`docs/vision.md`](docs/vision.md)).

## Architecture

Internally the loop is: **schedulers** tick a lane → the **lane pipeline** gathers
layered **signals** (passive observation, provider status-page piggybacking, sparse
active probes) → **status-model** resolves them into one of four states with a
corroboration guard against provider false-positives → the result is persisted to
the **SQLite state store** → the shared status-watcher calls the lane's
**ControlAdapter** to reconcile Multica agent concurrency. Every tick, status flip,
and actuation attempt emits OTEL to Argus.

For full architectural details and the component flow diagram, see:
- [Architecture & Diagrams](https://mdostal.github.io/heimdall/architecture) or [`docs/architecture.md`](docs/architecture.md)

## How it fits

Heimdall is one god in **Pantheon**, the [pantheon-v2](https://github.com/mdostal/pantheon-v2)
host. It reads and actuates the orchestration substrate — **Multica**
([firefly-events/multica](https://github.com/firefly-events/multica)) — and
schedules its own health probes as **Multica autopilots** rather than local cron,
honoring the "no box runners" rule. Multica dispatches the SDLC work planned by
**plugin-hive** ([firefly-events.github.io/plugin-hive](https://firefly-events.github.io/plugin-hive/)).
Sibling gods: **Auriga** (the router that will call `GET /lanes` per dispatch),
**Vesta** (owns lane/agent config in Pantheon), **Portunus** (will own the
long-lived per-lane tokens), and **Argus** (receives Heimdall's telemetry).

## Quickstart

Requires **Node.js >= 22.5.0** (uses the built-in `node:sqlite` module — the
scripts pass `--experimental-sqlite`).

```bash
npm install
cp .env.example .env        # declare lanes + fill in tokens (never commit .env)
```

Lanes are declared as contiguous `HEIMDALL_LANE_<N>_{ID,PROVIDER,CREDENTIAL_REF}`
triples starting at `1`, with optional `HEIMDALL_LANE_<N>_MODEL` for advisory
routing; `CREDENTIAL_REF` names another env var holding the actual secret. A lane
with a missing or empty credential is still reported by `GET /lanes` — as `down`
with an `unconfigured` reason — rather than crashing the service or silently
disappearing.

**Never commit `.env`** — it's gitignored; only `.env.example` (with empty
secret values) is tracked.

## Run the real service

```bash
npm run dev            # full composed service on http://localhost:4870
npm run dev:http-only  # HTTP server only, no scheduling (isolated debugging)
```

Runs `src/main.ts` — the full composed service: lane registry + SQLite state
store + Argus OTEL telemetry + a per-lane `MulticaAutopilotScheduler` (coarse
cron, default) and `InProcessScheduler` (fine ~5s, suspect-lane only) + the
HTTP server on `http://localhost:4870` (override with `PORT=<n>`).

`GET /lanes` reads the SQLite state store (override the DB path with
`HEIMDALL_DB_PATH`, default in-memory). `POST /lanes/:laneId/refresh` triggers a real 
refresh on demand. `GET /available-route?task-type=planning|build|review` returns one usable
advisory route backed by the same lane state.

`POST /route` invokes the policy-driven router, accepting a JSON body with `task_id`, `task_type`, and `estimated_cost`, and returning a complete routing decision including the chosen lane, candidate scores, and rationale.

## Query lane status & route selection — CLI

```bash
# HTTP
curl http://localhost:4870/lanes
curl -X POST http://localhost:4870/lanes/<laneId>/refresh   # force a refresh
curl http://localhost:4870/healthz                          # liveness only, no lane data
curl -X POST http://localhost:4870/route -H "Content-Type: application/json" -d '{"task_id":"abc", "task_type":"build"}'

# CLI - Lane List
npm run cli                     # JSON (default)
npm run cli -- --format table   # human-readable table

# CLI - Route Selection
npm run cli -- route --task-type=build --task-id=abc            # rationale to stdout
npm run cli -- route --task-type=build --task-id=abc --json     # JSON to stderr, lane to stdout

# MCP (stdio server exposing the heimdall.lanes.list and route_selection tools)
npm run mcp
```

**Actuation** (v2) is enabled per-lane by mapping it to Multica agents via
`HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS` plus `MULTICA_BASE_URL` /
`MULTICA_WORKSPACE_ID` / `MULTICA_PAT_TOKEN`. Mapped lanes get the real
`MulticaControlAdapter`; everything else falls back to a loud `StubControlAdapter`
(log-only, never a silent no-op). See [`.env.example`](.env.example) for every
knob.

## Support & OSS

We welcome contributions and value community involvement! 

- Read our [Contributing Guide](CONTRIBUTING.md) to get started.
- See the [Vision & Roadmap](docs/vision.md) to understand where Heimdall is headed.

If Heimdall helps your agent infrastructure, please consider supporting the project:
- ❤️ **[Sponsor on GitHub](https://github.com/sponsors/mdostal)**
- ☕ **[Buy Me A Coffee](https://www.buymeacoffee.com/mdostal)**
