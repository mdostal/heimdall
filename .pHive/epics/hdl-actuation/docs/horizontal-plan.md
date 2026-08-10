# Horizontal Planning Scan — Actuation / CONTROL-Adapter Layer

## 1. Layer Inventory

- **MulticaRestClient** — injectable HTTP client, timeout + graceful-failure result type, mandatory base-URL/workspace/auth config.
- **CircuitBreaker** — generic failure-counting wrapper, opens/half-opens/closes.
- **LaneAgentResolver** — lane_id → Multica agent ID(s) mapping, interface + static env-driven impl.
- **ControlAdapter** — the reconcile-every-tick interface; `StubControlAdapter` + `MulticaControlAdapter` implementations.
- **Argus extension** — new `emitActuationResult` method on `ArgusEmitter`.
- **Wiring** — `src/main.ts` status-watcher loop calls `reconcile()` per lane per tick instead of (or alongside) `ActuationStub.onStatusChange`.
- **Decision record** — `docs/decisions/DEC-hdl-role-actuation.md`, capturing the corrected Multica facts + all 4 resolved design decisions.

## 2. Per-Layer Requirements

```
## Layer: MulticaRestClient

NEEDED:
  - Config resolution: MULTICA_BASE_URL (required), MULTICA_WORKSPACE_ID (required),
    Bearer token via CredentialSource (reused, not reinvented)
  - listAgents(), updateAgent(id, {max_concurrent_tasks}), archiveAgent(id),
    restoreAgent(id), listRuntimes(), patchRuntime(id, patch)
  - Every call: short timeout (AbortController), workspace_id query param
    appended automatically, never throws — returns a MulticaCallResult
    (ok | timeout | unreachable | http_error) discriminated union
  - Injectable fetchImpl (mirrors signal-sources/* pattern) — tests use a
    local fake HTTP server / mocked fetch, never the real hive

---

## Layer: CircuitBreaker

NEEDED:
  - Wraps an arbitrary async call; tracks consecutive failures
  - Opens after N consecutive failures (config, default e.g. 3): further
    calls short-circuit immediately (return "circuit_open", no network attempt)
  - Half-opens after a cooldown window: allows exactly one trial call
  - Closes again on a successful call; re-opens on a failed trial call
  - Generic — not Multica-specific, reusable for any flaky external call

---

## Layer: LaneAgentResolver

NEEDED:
  - Interface: resolve(laneId): string[] (agent IDs, empty if unmapped)
  - StaticLaneAgentResolver: reads HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS
    (comma-separated) per declared lane
  - Designed so a v2 DiscoveryLaneAgentResolver (GET /api/agents matching
    provider+model) can implement the same interface later

---

## Layer: ControlAdapter

NEEDED:
  - Interface: reconcile(lane, status): Promise<void> — called every tick,
    every lane, not gated by transition-detection
  - StubControlAdapter: wraps existing ActuationStub transition-detection,
    loud logging only, for unmapped lanes
  - MulticaControlAdapter: per-agent last-applied-state tracking, idempotent
    reconcile (mismatch persists until a call succeeds — no bespoke retry
    bookkeeping), 1:N lane->agent handling with per-agent partial-failure
    log-and-continue, Argus emitActuationResult on every attempt

---

## Layer: Argus Extension

NEEDED:
  - New ArgusEmitter method: emitActuationResult({laneId, provider, agentId,
    action, success, reason}) — fire-and-forget, same pattern as existing
    emitTick/emitStatusFlip

---

## Layer: Wiring

NEEDED:
  - src/main.ts: per-lane ControlAdapter selection (MulticaControlAdapter if
    LaneAgentResolver returns agent IDs, else StubControlAdapter), called
    from the existing shared status-watcher loop every tick

---

## Layer: Decision Record

NEEDED:
  - docs/decisions/DEC-hdl-role-actuation.md — the ID docs/heimdall-role-and-
    actuation.md already cites but that doesn't exist yet. Records: corrected
    Multica API facts (max_concurrent_tasks not status/archive, workspace_id
    mandatory, two distinct Multica instances), all 4 resolved open questions,
    the flaky-connection hardening requirements.
```

## 3. Cross-Layer Dependencies

```
DEPENDENCIES:

CircuitBreaker wraps MulticaRestClient's calls (composition, not inheritance)
MulticaControlAdapter -> MulticaRestClient (via CircuitBreaker) + LaneAgentResolver
MulticaControlAdapter -> Argus (emitActuationResult)
StubControlAdapter -> existing ActuationStub (hdl-04, reused as-is)
Wiring -> ControlAdapter (selects impl per lane) + LaneAgentResolver (selection input)
Decision Record -> no code dependency, written to reflect what's actually built
```

## 4. Layer Map Diagram

```
HORIZONTAL LAYER MAP
─────────────────────────────────────────────────────────────────────
MulticaRestClient │ config resolution │ listAgents/updateAgent/       │
                  │ (URL/workspace/    │ archive/restore/runtimes,     │
                  │ token)             │ timeout + result type          │
──────────────────┼────────────────────┼────────────────────────────────┤
CircuitBreaker    │ generic wrapper    │                                │
──────────────────┼────────────────────┼────────────────────────────────┤
LaneAgentResolver │ interface          │ StaticLaneAgentResolver        │
──────────────────┼────────────────────┼────────────────────────────────┤
ControlAdapter    │ interface          │ StubControlAdapter +           │
                  │                    │ MulticaControlAdapter          │
──────────────────┼────────────────────┼────────────────────────────────┤
Argus Extension   │ emitActuationResult│                                │
──────────────────┼────────────────────┼────────────────────────────────┤
Wiring/Docs       │                    │ main.ts + DEC-hdl-role-        │
                  │                    │ actuation.md                   │
─────────────────────────────────────────────────────────────────────
```

## 5. Scope Summary

```
HORIZONTAL SCOPE:
  Layers affected: 6 (rest client, circuit breaker, resolver, control
    adapter, Argus extension, wiring) + decision record
  Total items: ~10
  New vs modified: mostly new; ArgusEmitter interface gets one new method
  Estimated total effort: medium

  LARGEST LAYER: MulticaControlAdapter (idempotent reconcile + multi-agent
    partial-failure handling is the most behaviorally subtle piece)
  RISKIEST LAYER: MulticaRestClient (flaky-connection hardening — timeout/
    circuit-breaker correctness matters a lot given the hive's known-flaky
    WAN connection)
```
