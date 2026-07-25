# Vertical Planning — Slice Plan — Pluggable Per-Lane Scheduler

## 1. Slicing Strategy

```
STRATEGY:
  Total horizontal items: ~12
  Planned slices: 5
  First slice goal: Scheduler interface + Argus telemetry client exist and are
    independently testable, with zero real backend logic yet
  Final slice goal: a real service entrypoint starts both backends per lane,
    ticks flow through to Argus, and the decision record reflects what
    actually got built

  Slicing rationale: InProcessScheduler has no external-system dependency
    (pure timer + StateStore polling) so it can be built and proven before
    MulticaAutopilotScheduler, which depends on a real external CLI and the
    already-resolved-but-cross-repo agent-provisioning question. The
    actuation stub is explicitly scoped down (stub only) so it's a thin,
    late slice. Wiring + the decision record come last since they depend on
    every other piece existing.
```

## 2. Vertical Slice Plan

```
## Slice 1: Scheduler Interface + Argus Telemetry Client

WHAT WORKS AFTER THIS STEP:
  The Scheduler interface exists (no concrete backend yet), and an Argus OTEL
  client can emit a tick/status-flip event against a mocked exporter,
  proving the fire-and-forget failure-handling shape works before any real
  scheduler calls it.

LAYERS TOUCHED:
  Scheduler Interface: src/core/scheduler/scheduler.ts
  Argus Telemetry: src/core/telemetry/argus-client.ts

NOT YET:
  Any concrete Scheduler implementation, any real OTLP network call

VERIFIED BY:
  - Unit test: emitTick/emitStatusFlip call a mocked OTLP exporter with the
    right span/metric shape
  - Unit test: exporter failure is caught and logged, never thrown

COMMIT REPRESENTS: Scheduler contract + telemetry client, no backends yet

---

## Slice 2: InProcessScheduler (fine ticker, suspect-lane only)

BUILDS ON: Slice 1
WHAT WORKS AFTER THIS STEP:
  A lane that goes degraded/down/out_of_credit gets fine ~5s ticking calling
  LanePipeline.refresh() until it recovers to up, at which point ticking
  stops immediately. Overlap-guarded, error-isolated.

LAYERS TOUCHED:
  InProcess Backend: src/core/scheduler/in-process-scheduler.ts

NOT YET:
  MulticaAutopilotScheduler, actuation stub, real service wiring

VERIFIED BY:
  - Unit test: engages on degraded/down/out_of_credit, disengages on up
  - Unit test: overlap guard skips a tick when the previous refresh() is
    still in-flight
  - Unit test: a throwing refresh() doesn't wedge the loop (next tick still fires)
  - Unit test: emits to Argus on every tick and on every status flip

COMMIT REPRESENTS: Fine suspect-lane corroboration ticking, fully working end-to-end

---

## Slice 3: MulticaAutopilotScheduler (coarse cron backend)

BUILDS ON: Slice 1
WHAT WORKS AFTER THIS STEP:
  Calling start() on a lane's MulticaAutopilotScheduler registers (or
  confirms) a cron-driven Multica autopilot pointing at the configured
  agent, via an injectable CommandRunner — no real multica daemon required
  in tests.

LAYERS TOUCHED:
  Multica Backend: src/core/scheduler/multica-autopilot-scheduler.ts

NOT YET:
  Actuation stub, real service wiring, DEC doc

VERIFIED BY:
  - Unit test: constructs the exact `multica autopilot trigger-add ...`
    command shape (mocked CommandRunner, asserting args)
  - Unit test: rejects/normalizes a cron expression that violates the 1-min floor
  - Unit test: missing MULTICA_AUTOPILOT_AGENT env var fails clearly, doesn't crash silently

COMMIT REPRESENTS: Coarse cron backend, real-CLI-shape-verified without touching a live daemon

---

## Slice 4: Actuation Stub (3rd interaction mode)

BUILDS ON: Slice 1
WHAT WORKS AFTER THIS STEP:
  A status-change event (lane goes from one status to another) fires
  onStatusChange(lane, from, to), which — for this epic — just records/logs
  the intended future action (toggle this lane's runtime in Multica) rather
  than actually calling any Multica runtime-toggle API.

LAYERS TOUCHED:
  Actuation Stub: src/core/scheduler/actuation-stub.ts

NOT YET:
  Real Multica runtime on/off API calls (explicitly future scope, not this epic)

VERIFIED BY:
  - Unit test: fires exactly once per genuine status transition, not on
    repeated identical statuses
  - Unit test: stub records the intended action without calling any real
    external API (no network/CLI dependency in this slice)

COMMIT REPRESENTS: Third interaction mode scaffolded as an explicit stub

---

## Slice 5: Entrypoint Wiring + Decision Record

BUILDS ON: Slices 1-4
WHAT WORKS AFTER THIS STEP:
  src/main.ts starts the real service: builds the lane registry + state
  store + Argus client, constructs a MulticaAutopilotScheduler per lane
  (always-on default) plus the shared InProcessScheduler poll loop, wires
  the actuation stub to status flips, and starts the HTTP server. The
  decision record at docs/decisions/DEC-hdl-scheduler-backend.md formalizes
  what was actually built.

LAYERS TOUCHED:
  Wiring: src/main.ts
  Decision Record: docs/decisions/DEC-hdl-scheduler-backend.md

NOT YET:
  Nothing — this is the last slice in the epic

VERIFIED BY:
  - Integration test: starting src/main.ts's composition function wires all
    lanes with a MulticaAutopilotScheduler and engages InProcessScheduler
    correctly when a lane is seeded as degraded
  - Manual: once Open Question #1's cross-repo Multica agent exists, register
    one real autopilot and confirm a tick fires

COMMIT REPRESENTS: v1.1 (scheduler epic) complete
```

## 3. Overlay Diagram

```
VERTICAL SLICE OVERLAY
──────────────────────────────────────────────────────────────────────
              │ Slice 1     │ Slice 2      │ Slice 3       │ Slice 4     │ Slice 5   │
              │ (interface) │ (in-process) │ (multica)     │ (actuation) │ (wiring)  │
──────────────┼─────────────┼──────────────┼───────────────┼─────────────┼───────────┤
Scheduler     │ interface   │              │               │             │           │
Interface     │             │              │               │             │           │
──────────────┼─────────────┼──────────────┼───────────────┼─────────────┼───────────┤
InProcess     │             │ full impl    │               │             │           │
Backend       │             │              │               │             │           │
──────────────┼─────────────┼──────────────┼───────────────┼─────────────┼───────────┤
Multica       │             │              │ full impl     │             │           │
Backend       │             │              │               │             │           │
──────────────┼─────────────┼──────────────┼───────────────┼─────────────┼───────────┤
Argus         │ client      │ used         │ used          │             │           │
Telemetry     │             │              │               │             │           │
──────────────┼─────────────┼──────────────┼───────────────┼─────────────┼───────────┤
Actuation     │             │              │               │ stub        │ wired     │
Stub          │             │              │               │             │           │
──────────────┼─────────────┼──────────────┼───────────────┼─────────────┼───────────┤
Wiring/Docs   │             │              │               │             │ main.ts + │
              │             │              │               │             │ DEC doc   │
──────────────────────────────────────────────────────────────────────
```

## 4. Deferred Items

```
DEFERRED (not in current slice plan):
  - Real Multica runtime on/off API calls (actuation stub stays a stub) —
    future epic once the actual Multica-side toggle API/contract is defined
  - Provisioning the actual Multica-side agent the autopilot dispatches —
    cross-repo, Multica's own concern, not Heimdall's
  - Gradual backoff curve for InProcessScheduler (immediate stop chosen for v1)
  - Event-driven (vs. poll-based) suspect-lane engagement

RATIONALE: All explicitly resolved as out-of-scope-for-now during the design
  discussion review gate (2026-07-25) — not scope creep by omission.
```

## 5. Risk by Slice

```
RISK PER SLICE:
  Slice 1: Low — pure interfaces + a mockable client, no real integration.
  Slice 2: Medium — the engage/disengage + overlap/error invariants are
    behaviorally subtle; this is where a bug would most directly violate
    the HARD LAW's anti-self-racing intent.
  Slice 3: Medium — first real external-CLI shelling-out in this codebase;
    mitigated by full command-construction testing without touching a live daemon.
  Slice 4: Low — deliberately scoped to a stub, minimal surface.
  Slice 5: Low-Medium — integration/wiring risk (did every piece actually
    compose correctly), but no new business logic.
```

## 6. Moldability Notes

- Slices 2 and 3 are fully independent of each other (both only depend on Slice 1) — could be reordered or built in parallel if desired.
- Slice 4 (actuation stub) could be dropped entirely from this epic without invalidating 1-3, 5 if time runs short — it's explicitly a stub with no real behavior yet. Recommend keeping it since it's small and the operator explicitly asked for it as a scaffolded third interaction mode.
- If Slice 3's real-world manual verification (registering an actual Multica autopilot) reveals the CLI shape doesn't match what was inferred from research, only Slice 3 needs rework — Slices 1, 2, 4, 5 are unaffected.
