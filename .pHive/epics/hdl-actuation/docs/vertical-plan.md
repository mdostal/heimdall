# Vertical Planning — Slice Plan — Actuation / CONTROL-Adapter Layer

## 1. Slicing Strategy

```
STRATEGY:
  Total horizontal items: ~10
  Planned slices: 5
  First slice goal: MulticaRestClient + CircuitBreaker exist, fully
    flaky-connection-hardened, tested against a local fake HTTP server —
    zero real actuation logic yet
  Final slice goal: real actuation wired end-to-end in src/main.ts, with the
    decision record reflecting what was actually built

  Slicing rationale: the external-facing, flakiness-hardened HTTP layer
    (MulticaRestClient + CircuitBreaker) is the highest-risk piece and has
    no dependency on the rest of the epic, so it goes first and gets proven
    in isolation. LaneAgentResolver and the ControlAdapter interface (+
    StubControlAdapter, trivial since it just reuses hdl-04's ActuationStub)
    can build in parallel with each other and with the rest-client slice.
    MulticaControlAdapter depends on all three and is the most behaviorally
    complex piece, so it lands after they're proven. Wiring + decision
    record come last.
```

## 2. Vertical Slice Plan

```
## Slice 1: MulticaRestClient + CircuitBreaker (flaky-connection hardened)

WHAT WORKS AFTER THIS STEP:
  A fully-configured MulticaRestClient can call a local fake HTTP server
  and get back listAgents/updateAgent/archiveAgent/restoreAgent/listRuntimes/
  patchRuntime results; a timeout or network error resolves to a graceful
  result (never throws), and CircuitBreaker opens after repeated failures.

LAYERS TOUCHED:
  MulticaRestClient: src/core/actuation/multica-rest-client.ts
  CircuitBreaker: src/core/actuation/circuit-breaker.ts

NOT YET:
  LaneAgentResolver, ControlAdapter, any actuation decision logic

VERIFIED BY:
  - Unit tests: correct request shape (URL, workspace_id query param, Bearer
    header) for every method; timeout resolves to a graceful "timeout"
    result, not a throw; a 4xx/5xx resolves to "http_error", not a throw
  - Unit tests: CircuitBreaker opens after N consecutive failures, skips
    calls while open, half-opens after cooldown, closes on a successful
    trial call

COMMIT REPRESENTS: The hardened HTTP layer, proven against a local fake
  server — the highest-risk piece of this epic, isolated and tested first

---

## Slice 2: LaneAgentResolver + ControlAdapter interface + StubControlAdapter

BUILDS ON: nothing (independent of Slice 1)
WHAT WORKS AFTER THIS STEP:
  StaticLaneAgentResolver resolves lane_id -> agent IDs from env.
  StubControlAdapter (wrapping hdl-04's ActuationStub) implements the new
  ControlAdapter interface, logging loudly on genuine transitions for
  unmapped lanes.

LAYERS TOUCHED:
  LaneAgentResolver: src/core/actuation/lane-agent-resolver.ts
  ControlAdapter interface + StubControlAdapter: src/core/actuation/control-adapter.ts

NOT YET:
  MulticaControlAdapter, wiring

VERIFIED BY:
  - Unit tests: resolves comma-separated agent IDs correctly; returns empty
    for an unmapped lane
  - Unit tests: StubControlAdapter fires loud log exactly once per genuine
    transition (reusing hdl-04's existing transition-detection tests as a
    baseline), never for repeated identical status

COMMIT REPRESENTS: Lane-to-agent mapping + the log-only default path, ready
  for the real adapter to plug into the same interface

---

## Slice 3: MulticaControlAdapter (idempotent reconcile)

BUILDS ON: Slice 1, Slice 2
WHAT WORKS AFTER THIS STEP:
  A mapped lane's status flip to suspect triggers max_concurrent_tasks=0 for
  every mapped agent; recovery restores the remembered prior value. A failed
  attempt leaves the mismatch in place so the next reconcile() call retries
  automatically — no bespoke retry bookkeeping. Partial multi-agent failures
  log-and-continue and emit an Argus metric per attempt.

LAYERS TOUCHED:
  MulticaControlAdapter: src/core/actuation/multica-control-adapter.ts
  Argus extension: src/core/telemetry/argus-client.ts (add emitActuationResult)

NOT YET:
  Wiring into main.ts, decision record

VERIFIED BY:
  - Unit tests: disable-then-restore round trip remembers and restores the
    exact prior max_concurrent_tasks value
  - Unit tests: a failed disable attempt is retried on the next reconcile()
    call without new status transition needed (idempotency proof)
  - Unit tests: 1:N lane->agent mapping with 2-of-3 succeeding logs the
    failure and continues, doesn't roll back the 2 successes
  - Unit tests: every attempt (success or failure) emits an Argus
    emitActuationResult call

COMMIT REPRESENTS: Real actuation logic, fully idempotent and
  partial-failure-tolerant, proven against mocked dependencies

---

## Slice 4: Wiring (src/main.ts)

BUILDS ON: Slice 1, 2, 3
WHAT WORKS AFTER THIS STEP:
  The shared status-watcher loop in src/main.ts calls the right
  ControlAdapter.reconcile(lane, status) for every lane, every tick —
  MulticaControlAdapter for mapped lanes, StubControlAdapter otherwise.

LAYERS TOUCHED:
  Wiring: src/main.ts

NOT YET:
  Decision record

VERIFIED BY:
  - Integration test: composeService's status watcher correctly selects and
    invokes the right adapter per lane (mocked MulticaRestClient/CircuitBreaker,
    no real network)

COMMIT REPRESENTS: Real actuation live in the composed service

---

## Slice 5: Decision Record

BUILDS ON: Slices 1-4
WHAT WORKS AFTER THIS STEP:
  docs/decisions/DEC-hdl-role-actuation.md exists, formalizing the corrected
  Multica API facts, the 4 resolved design decisions, and the
  flaky-connection hardening requirements — reflecting what was actually
  built.

LAYERS TOUCHED:
  Decision Record: docs/decisions/DEC-hdl-role-actuation.md

NOT YET:
  Nothing — last slice in the epic. Real end-to-end verification against
  the live hive :8090 instance is explicitly a follow-up the operator runs
  separately, not part of this epic.

VERIFIED BY:
  - Manual review: does the doc accurately reflect the shipped code, not
    just the plan?

COMMIT REPRESENTS: v2 (actuation) epic complete, ready to pull into the hive
```

## 3. Overlay Diagram

```
VERTICAL SLICE OVERLAY
──────────────────────────────────────────────────────────────────────────
              │ Slice 1      │ Slice 2       │ Slice 3        │ Slice 4  │ Slice 5 │
              │ (rest+cb)    │ (resolver+stub)│ (multica ctrl) │ (wiring) │ (DEC)   │
──────────────┼──────────────┼───────────────┼────────────────┼──────────┼─────────┤
RestClient    │ full impl    │               │                │          │         │
CircuitBreaker│ full impl    │               │                │          │         │
──────────────┼──────────────┼───────────────┼────────────────┼──────────┼─────────┤
Resolver      │              │ full impl     │                │          │         │
ControlAdapter│              │ interface +   │ +Multica impl  │          │         │
              │              │ stub impl     │                │          │         │
──────────────┼──────────────┼───────────────┼────────────────┼──────────┼─────────┤
Argus         │              │               │ +emitActuation │          │         │
              │              │               │ Result         │          │         │
──────────────┼──────────────┼───────────────┼────────────────┼──────────┼─────────┤
Wiring/Docs   │              │               │                │ main.ts  │ DEC doc │
──────────────────────────────────────────────────────────────────────────
```

## 4. Deferred Items

```
DEFERRED (not in current slice plan):
  - DiscoveryLaneAgentResolver (auto-map by provider+model via GET /api/agents)
    — v2 resolver, interface-ready but not built
  - Real end-to-end verification against the live hive :8090 instance —
    explicitly the operator's follow-up after this epic ships, not this
    epic's job
  - Renaming/wrapping the existing MCP/HTTP advisory surfaces — confirmed
    out of scope (Open Question #3)
  - Portunus-backed credential loading for the Multica PAT — reuses the same
    local .env stopgap CredentialSource already uses for lane credentials

RATIONALE: All explicitly resolved as out-of-scope-for-now during the
  design discussion (2026-07-25).
```

## 5. Risk by Slice

```
RISK PER SLICE:
  Slice 1: Medium-High — the flaky-connection hardening (timeout, circuit
    breaker) is genuinely the riskiest correctness surface in this epic;
    getting it wrong means Heimdall's sense loop could hang on a bad hive
    connection, which is exactly what this epic must prevent.
  Slice 2: Low — straightforward env parsing + reuse of hdl-04's already-
    proven transition-detection logic.
  Slice 3: Medium-High — idempotent reconcile + partial-failure handling is
    subtle; a bug here could either fail to disable an unhealthy lane's
    agents or fail to restore a healthy one's.
  Slice 4: Low-Medium — integration/wiring risk, no new business logic.
  Slice 5: Low — documentation only.
```

## 6. Moldability Notes

- Slices 1 and 2 are fully independent — could be built in parallel.
- If Slice 1's circuit-breaker design needs rework after real hive testing (post-epic, operator-run), only Slice 1 needs revisiting — Slices 2-5 are unaffected since they depend on MulticaRestClient's interface, not its internal retry/circuit behavior.
- Slice 3's Argus metric emission could be dropped without invalidating the rest if time runs short, but it's small and explicitly requested — recommend keeping it.
