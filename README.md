# Heimdall

**The health-aware lane gateway for [Pantheon](https://github.com/mdostal/pantheon-v2).**
Heimdall watches every LLM/runtime *lane* — a `provider × account × runtime`
triple like `claude@mathew.dostal`, `codex`, or `gemini-3-pro` — reports whether
each one is **up, down, out of credit, or degraded**, and actuates on that signal
by disabling or re-enabling a lane's mapped Multica agents.

## What & why

Agent fleets stall for boring reasons: one account hits its weekly cap while
others sit idle, or a runtime silently breaks (the classic codex OAuth hang) and
keeps accepting work it can't finish. A `--version` check is not proof a lane is
alive; only a real signal is. Heimdall exists as its own service so that this
sensing-and-actuation loop lives in **one** place with **one** contract, instead
of being re-implemented ad hoc inside every orchestrator, script, and daemon.

Today Heimdall is the **gateway half** of that vision: it *senses* lane health
from layered signals and *actuates* by toggling Multica agent concurrency. The
routing brain — "given this task, pick the best healthy lane" — is deliberately
out of scope for now and tracked as future work (see [`VISION.md`](VISION.md)).

## Architecture

```mermaid
flowchart TB
    subgraph Pantheon
        Auriga["Auriga (router / orchestrator)"]
        Vesta["Vesta (config)"]
        Portunus["Portunus (secrets — future)"]
        Argus["Argus (OTEL observability)"]
    end

    subgraph Heimdall["Heimdall service (:4870)"]
        direction TB
        Reg["Lane Registry\n(env-declared lanes)"]
        Sched["Schedulers\nMulticaAutopilot (coarse cron)\nInProcess (~5s, suspect lanes)"]
        Pipe["Lane Pipeline\n(per-lane sense loop)"]
        subgraph Signals["Signal sources (layered)"]
            Passive["passive\n(observed traffic)"]
            Public["public_status\n(provider status page)"]
            Probe["active_probe\n(cheap real call)"]
        end
        Model["status-model\n(4-state resolve +\ncorroboration)"]
        Store["State Store\n(node:sqlite)"]
        Ctrl["ControlAdapter\nMulticaControlAdapter | StubControlAdapter"]
        API["Query surfaces\nHTTP · CLI · MCP · Dashboard"]
    end

    Multica["Multica REST API\n(agents / runtimes)"]

    Vesta -. lane + agent config .-> Reg
    Portunus -. tokens (future) .-> Reg
    Sched --> Pipe
    Pipe --> Signals
    Signals --> Model
    Model --> Store
    Store --> API
    Store --> Ctrl
    Ctrl -->|max_concurrent_tasks 0/N| Multica
    Auriga -->|GET /lanes| API
    Sched -. cron trigger .-> Multica
    Multica -. POST /lanes/:id/refresh .-> API
    Heimdall -->|OTEL spans| Argus
```

Internally the loop is: **schedulers** tick a lane → the **lane pipeline** gathers
layered **signals** (passive observation, provider status-page piggybacking, sparse
active probes) → **status-model** resolves them into one of four states with a
corroboration guard against provider false-positives → the result is persisted to
the **SQLite state store** → the shared status-watcher calls the lane's
**ControlAdapter** to reconcile Multica agent concurrency. Every tick, status flip,
and actuation attempt emits OTEL to Argus.

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

`.env` is loaded automatically (`--env-file-if-exists=.env` on `dev`,
`dev:http-only`, `cli`, `mcp` — tolerant of a missing file, so a fresh clone
without `.env` yet still runs, just with zero declared lanes).

Lanes are declared as contiguous `HEIMDALL_LANE_<N>_{ID,PROVIDER,CREDENTIAL_REF}`
triples starting at `1`, with optional `HEIMDALL_LANE_<N>_MODEL` for advisory
routing; `CREDENTIAL_REF` names another env var holding the actual secret. A lane
with a missing or empty credential is still reported by `GET /lanes` — as `down`
with an `unconfigured` reason — rather than crashing the service or silently
disappearing. `POST /lanes` (see the dashboard section below) writes new lanes
in this exact shape.

**Never commit `.env`** — it's gitignored; only `.env.example` (with empty
secret values) is tracked. This is the REQ-07 local-secrets stopgap; Portunus
is the planned future fix for secret storage, not yet built.

## Run the real service

```bash
npm run dev            # full composed service on http://localhost:4870
npm run dev:http-only  # HTTP server only, no scheduling (isolated debugging)
```

Runs `src/main.ts` — the full composed service: lane registry + SQLite state
store + Argus OTEL telemetry + a per-lane `MulticaAutopilotScheduler` (coarse
cron, default) and `InProcessScheduler` (fine ~5s, suspect-lane only) + the
HTTP server on `http://localhost:4870` (override with `PORT=<n>`). See
[`docs/decisions/DEC-hdl-scheduler-backend.md`](docs/decisions/DEC-hdl-scheduler-backend.md)
for the scheduler design and the `multica-native-no-box-runners` HARD LAW it
satisfies. Requires `MULTICA_AUTOPILOT_AGENT` to be set (see `.env.example`)
for the Multica backend to register cron triggers; missing it fails that
lane's coarse scheduling clearly without crashing the rest of the service.

`GET /lanes` reads the SQLite state store (override the DB path with
`HEIMDALL_DB_PATH`, default in-memory), reflecting whatever the Claude/Codex
signal pipeline (`src/core/lane-pipeline.ts`) last persisted. `POST
/lanes/:laneId/refresh` triggers a real refresh on demand — this is the
endpoint Multica's dispatched agent calls when a lane's autopilot fires. To
run just the HTTP server without any scheduling (e.g. for isolated debugging),
use `npm run dev:http-only` instead — see
[`.pHive/epics/lane-health-status/docs/vertical-plan.md`](.pHive/epics/lane-health-status/docs/vertical-plan.md).

`GET /available-route?task-type=planning|build|review` returns one usable
advisory route backed by the same lane state. It only chooses lanes with an `up`
status and a resolved credential, and returns the credential reference handle
(`token-ref`) rather than the secret.

## Query lane status — CLI, HTTP, MCP, and the dashboard

```bash
# HTTP
curl http://localhost:4870/lanes
curl -X POST http://localhost:4870/lanes/<laneId>/refresh   # force a refresh
curl http://localhost:4870/healthz                          # liveness only, no lane data
curl -X POST http://localhost:4870/lanes/<laneId>/override \
  -H "content-type: application/json" -d '{"state":"disabled"}'   # manual override: enabled | disabled | auto
curl -X POST http://localhost:4870/lanes/<laneId>/reset-at \
  -H "content-type: application/json" -d '{"reset_at":"2026-08-13T18:00:00.000Z"}'   # or {"reset_at":null} to clear
curl -X POST http://localhost:4870/lanes \
  -H "content-type: application/json" \
  -d '{"lane_id":"gemini@ops","provider":"gemini","model":"gemini-3-pro","token":"..."}'   # add a lane

# CLI
npm run cli                     # JSON (default)
npm run cli -- --format table   # human-readable table

# MCP (stdio server — 4 tools, see below)
npm run mcp
```

**Dashboard** — `GET /` (open `http://localhost:4870/` in a browser) serves a
self-contained live lane-status view: no build step, no framework, no
external network calls — it's a pure consumer of Heimdall's own HTTP
endpoints, polled every 5s.

- **On/off** — per-lane enable/disable/auto controls, backed by
  `POST /lanes/:laneId/override`. The override wins outright over the sensed
  status until cleared back to `auto`, routed through the same
  `ControlAdapter.reconcile()` decision automatic status-driven actuation
  already uses (not a separate mechanism — see
  [`docs/decisions/DEC-hdl-reason-aware-recovery.md`](docs/decisions/DEC-hdl-reason-aware-recovery.md)
  item 3). Always shown as a distinct "manual: …" badge, never silent.
- **Add lane** — a form backed by `POST /lanes`, which writes a new
  `HEIMDALL_LANE_<N>_*` block (+ its secret line) to the local, gitignored
  `.env` (see `src/core/env-file.ts`). Does **not** restart the process —
  the response names the exact command to run (`npm run dev`); the new lane
  is inert until then.
- **Token status** — a "configured" / "token missing" chip per lane
  (`credential_configured`), reflecting whether its credential resolved.
  The raw secret is never sent to the browser under any field, matching
  every other credential-handling path in this codebase.
- **Change the times** — an editable reset-at control per lane, backed by
  `POST /lanes/:laneId/reset-at`. An operator who knows a lane's real
  recovery time (a plan reset the automatic probes can't see, say) can set
  it directly; `InProcessScheduler` prefers it over the sensed `reset_at`
  when deciding when to check again (scheduling-only — doesn't touch
  actuation). Shown with a "manual" badge whenever active.

**MCP tools** — `npm run mcp` exposes all four HTTP operations above as MCP
tools (an agent, not just a human at the dashboard, can exercise/test
Heimdall — closing out
[`docs/decisions/DEC-hdl-reason-aware-recovery.md`](docs/decisions/DEC-hdl-reason-aware-recovery.md)
item 3). Every tool calls the exact same shared functions the HTTP routes
do (`getLaneStatuses`/`setLaneOverride`/`setLaneResetAt`/`addLane` in
`src/api/http-server.ts`) — no duplicated validation logic between the two
surfaces:

| Tool | Wraps | Input |
|---|---|---|
| `heimdall.lanes.list` | `GET /lanes` | *(none)* |
| `heimdall.lanes.override` | `POST /lanes/:laneId/override` | `{lane_id, state: "enabled"\|"disabled"\|"auto"}` |
| `heimdall.lanes.setResetAt` | `POST /lanes/:laneId/reset-at` | `{lane_id, reset_at: string \| null}` |
| `heimdall.lanes.add` | `POST /lanes` | `{lane_id, provider, model, token}` |

A validation failure (unknown lane, invalid state, a duplicate lane_id,
etc.) returns structured `{ok: false, error, ...}` text content — the same
never-throws-on-bad-input philosophy `heimdall.lanes.list` already has, and
REQ-07's "down/unconfigured is data, not an exception" pattern applied to
every tool. Only a genuinely unrecognized tool *name* throws a real MCP
protocol error.

Other scripts: `npm test` (Node built-in test runner via `tsx`),
`npm run build` (type-check + compile to `dist/`), `npm run sla-report`
(status-correctness SLA harness).

**Actuation** (v2) is enabled per-lane by mapping it to Multica agents via
`HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS` plus `MULTICA_BASE_URL` /
`MULTICA_WORKSPACE_ID` / `MULTICA_PAT_TOKEN`. Mapped lanes get the real
`MulticaControlAdapter`; everything else falls back to a loud `StubControlAdapter`
(log-only, never a silent no-op). See [`.env.example`](.env.example) for every
knob.

## Status

**Live / working scaffold (v0.4.0).** Sensing (4-state lane health across layered
signals, SLA-verified) and actuation (Multica agent concurrency toggling via a
circuit-breaker-hardened REST client) both run; actuation is tested against local
mocks only — live end-to-end against the hive Multica is an explicit operator
follow-up, and health-aware *routing* is not built yet. Full trajectory and how to
contribute: **[VISION.md](VISION.md)**.
