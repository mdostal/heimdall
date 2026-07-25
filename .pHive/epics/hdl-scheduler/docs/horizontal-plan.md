# Horizontal Planning Scan — Pluggable Per-Lane Scheduler

## 1. Layer Inventory

- **Scheduler interface** — the pluggable contract every backend implements; doesn't exist yet.
- **MulticaAutopilotScheduler backend** — coarse cron trigger via real `multica` CLI.
- **InProcessScheduler backend** — fine ~5s ticker, suspect-lane only.
- **Argus telemetry client** — first Node/TS OTEL emitter in Pantheon.
- **Actuation stub** — third interaction mode (status-change → future runtime on/off).
- **Decision record** — `DEC-hdl-scheduler-backend`, formalizing what's scattered across 3 files.
- **Wiring/entrypoint** — something has to actually construct + start a scheduler per lane at service startup.

## 2. Per-Layer Requirements

```
## Layer: Scheduler Interface

NEEDED:
  - Scheduler interface: start(): void, stop(): void — provider/backend-agnostic
  - No backend-specific logic leaks into the interface itself

---

## Layer: MulticaAutopilotScheduler

NEEDED:
  - CommandRunner injectable interface (mirrors existing fetchImpl injection
    pattern) so tests never shell out to a real multica daemon
  - Builds + runs: `multica autopilot trigger-add <autopilot-id> --kind schedule
    --cron "<cron>" --output json`, autopilot-id derived from lane_id,
    agent identifier from env (MULTICA_AUTOPILOT_AGENT)
  - Idempotent on start() (multica's own reconciler upserts by title — don't
    duplicate registration logic Heimdall-side)
  - Cron expression must respect the 1-minute floor — validate before shelling out

---

## Layer: InProcessScheduler

NEEDED:
  - Per-lane timer (setTimeout-recursion, not setInterval), ~5s cadence
  - Engages ONLY when StateStore.getCurrentStatus(lane).status is
    degraded/down/out_of_credit (poll-based per resolved Open Question #3)
  - Disengages (stops ticking) immediately once status resolves back to `up`
    (resolved Open Question #4 — immediate stop, no gradual backoff for v1)
  - Overlap guard (skip tick if previous refresh() still in-flight) + error
    isolation (one bad tick must not wedge the loop) — same invariants as
    hpr-2's design notes and the abandoned naive-scheduler draft

---

## Layer: Argus Telemetry Client

NEEDED:
  - Thin wrapper over @opentelemetry/api + @opentelemetry/sdk-node + an OTLP
    exporter (gRPC to host:4327 or HTTP to host:4328, configurable)
  - emitTick(lane, source) and emitStatusFlip(lane, from, to) functions
  - Fire-and-forget: emission failures logged, never thrown — Argus being
    unreachable must not break Heimdall's core health-check function
  - Mockable exporter for tests (no live Argus connection required to pass
    the test suite)

---

## Layer: Actuation Stub (3rd interaction mode)

NEEDED:
  - A function/interface fired on lane status change (e.g. onStatusChange(lane,
    from, to)) — stub only: logs/records the intended action, does not yet
    call any real Multica runtime-toggle API
  - Documented clearly as a stub/future extension point, not full actuation

---

## Layer: Decision Record

NEEDED:
  - docs/decisions/DEC-hdl-scheduler-backend.md — formalizes the two-backend
    shape, the HARD LAW constraint, and the Argus emit requirement, superseding
    the original single-timer architecture note

---

## Layer: Wiring/Entrypoint

NEEDED:
  - Something (src/main.ts, new) builds LaneRegistry + StateStore + Argus
    client, constructs one MulticaAutopilotScheduler per lane (always) +
    wires InProcessScheduler's poll-based engagement, and starts the HTTP
    server — the actual "real service" entrypoint that npm run dev should use
```

## 3. Cross-Layer Dependencies

```
DEPENDENCIES:

MulticaAutopilotScheduler + InProcessScheduler → Scheduler interface (both implement it)
InProcessScheduler → StateStore (reads current status to decide engagement)
Both backends → LanePipeline.refresh() (what they actually invoke — untouched)
Both backends → Argus Telemetry Client (emit on every tick)
Actuation Stub → StateStore / LanePipeline (needs to observe status flips to fire)
Wiring/Entrypoint → everything above (constructs and starts it all)
Decision Record → no code dependency, but should be written before/alongside
  the backends so it reflects what was actually built, not just the plan
```

## 4. Layer Map Diagram

```
HORIZONTAL LAYER MAP
─────────────────────────────────────────────────────────────────────
Scheduler     │ Scheduler interface  │                                │
Interface     │ (start/stop)         │                                │
──────────────┼──────────────────────┼────────────────────────────────┤
Multica       │                      │ CommandRunner + trigger-add     │
Backend       │                      │ wiring, cron floor validation   │
──────────────┼──────────────────────┼────────────────────────────────┤
InProcess     │                      │ per-lane timer, engage/disengage│
Backend       │                      │ overlap guard, error isolation  │
──────────────┼──────────────────────┼────────────────────────────────┤
Argus         │ emitTick /           │                                │
Telemetry     │ emitStatusFlip       │                                │
──────────────┼──────────────────────┼────────────────────────────────┤
Actuation     │ onStatusChange stub  │                                │
Stub          │                      │                                │
──────────────┼──────────────────────┼────────────────────────────────┤
Decision      │ DEC-hdl-scheduler-   │                                │
Record        │ backend.md           │                                │
──────────────┼──────────────────────┼────────────────────────────────┤
Wiring        │                      │ src/main.ts entrypoint          │
─────────────────────────────────────────────────────────────────────
```

## 5. Scope Summary

```
HORIZONTAL SCOPE:
  Layers affected: 6 (scheduler interface, 2 backends, telemetry, actuation
    stub, decision record) + entrypoint wiring
  Total items: ~12
  New vs modified: mostly new; LaneRegistry gets a small extension (per-lane
    scheduler config resolution)
  Estimated total effort: medium

  LARGEST LAYER: InProcessScheduler (engage/disengage + overlap/error
    invariants is the most behaviorally subtle piece)
  RISKIEST LAYER: MulticaAutopilotScheduler (real external CLI dependency,
    cross-repo agent-provisioning question already resolved but the actual
    Multica-side agent still needs to exist for manual verification)
```
