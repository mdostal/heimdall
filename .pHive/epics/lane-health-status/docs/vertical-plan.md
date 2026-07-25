# Vertical Planning — Slice Plan — Lane Health & Status

## 1. Slicing Strategy

```
STRATEGY:
  Total horizontal items: ~18
  Planned slices: 6 (+ 1 non-code spike that gates slices 3-4)
  First slice goal: prove the shape end-to-end with fixture data — a real
    `GET /lanes` returning fake but correctly-shaped status
  Final slice goal: SLA-verified, two-provider, three-transport health/status
    service (full P0 scope per PRD)

  Slicing rationale: the spike (REQ-00) is the one hard dependency, so slices
    are ordered to let everything NOT gated by it (skeleton, data model,
    credential loading, fixture-backed transport) proceed and land before the
    spike-gated adapter work starts. Slice boundaries follow the cross-layer
    dependencies from the horizontal scan: credential loading before passive
    observation, passive observation before public-status/active-probe
    (since the spike informs the latter two, not the former), one provider
    fully working before adding the second (proves the pattern generalizes
    before committing to it), transports added only once there's real signal
    behavior worth exposing, SLA harness last since it needs real state-flip
    behavior to measure.
```

## 2. Vertical Slice Plan

```
## Slice 0 (pre-code): REQ-00 Signal Inventory Spike

WHAT WORKS AFTER THIS STEP:
  Nothing runs yet — this produces a written artifact, not code. But every
  downstream slice touching Claude/Codex adapter content now has evidence
  instead of assumptions to build against.

DELIVERABLE:
  - .pHive/epics/lane-health-status/docs/signal-inventory.md — per-provider
    (Claude, Codex): error codes seen, quota-reset signal format, payment-
    failure signal format, public status-endpoint machine-readability

NOT YET:
  - Any adapter code

VERIFIED BY:
  - Manual review: does the inventory actually answer what REQ-02/REQ-03 need?

COMMIT REPRESENTS: Signal inventory spike — gates the two provider adapters

---

## Slice 1: Service Skeleton + Fixture-Backed HTTP

WHAT WORKS AFTER THIS STEP:
  `GET /lanes` on a local Node/TS service returns a correctly-shaped
  (but hardcoded/fixture) list of lane statuses matching the LaneRouterContract.

LAYERS TOUCHED:
  Skeleton: package.json, tsconfig.json, src/ layout
  Signal Detection: status-model.ts (4-state type, no real resolution logic yet)
  Query Surfaces: api/http-server.ts serving GET /lanes from a fixture array

NOT YET:
  - Real credential loading, real signal sources, CLI/MCP, state storage

VERIFIED BY:
  - Unit test: GET /lanes returns the LaneRouterContract shape
  - Manual: curl the endpoint, confirm JSON shape matches architecture.md's contract

COMMIT REPRESENTS: Service skeleton proving the API contract shape end-to-end

---

## Slice 2: Real Credential Loading + State Storage

BUILDS ON: Slice 1
WHAT WORKS AFTER THIS STEP:
  Lanes are now loaded from a real local `.env`/vault file (not a fixture list),
  and their status is persisted to/read from SQLite instead of an in-memory array.
  Status is still a static "unconfigured" placeholder per lane — no real signal yet.

LAYERS TOUCHED:
  Credential Loading: credential-source.ts + local .env/vault implementation (REQ-07)
  State Storage: SQLite schema (lanes, lane_status_history) + state-store.ts
  Signal Detection: lane-registry.ts (loads lanes + CredentialSource)

NOT YET:
  - Real signal sources (passive/public-status/active-probe) — status stays a
    placeholder value, not yet derived from real observation
  - CLI/MCP surfaces

VERIFIED BY:
  - Unit test: missing/invalid credential → lane reported down/unconfigured,
    service does not crash (REQ-07 acceptance criterion)
  - Unit test: state-store read/write round-trips correctly

COMMIT REPRESENTS: Real credential loading + persistent state, still no real signal

---

## Slice 3: Passive Observation + Public-Status + Active-Probe for Claude
## (Implemented as stories lhs-03a-03f — decomposed 2026-07-25 per operator
##  request into 5 independently-unit-testable pieces + 1 integration story,
##  to reduce per-story failure surface. See epic.yaml / stories/lhs-03*.yaml.)

BUILDS ON: Slice 2, Slice 0 (spike)
WHAT WORKS AFTER THIS STEP:
  The Claude lane's status is now REAL — derived from the layered signal model
  (REQ-01 passive, REQ-02 public-status, REQ-03 sparse active-probe), resolved
  through the full 4-state model (REQ-04).

LAYERS TOUCHED:
  Signal Detection: signal-sources/passive.ts (generic), signal-sources/
    public-status/claude.ts, signal-sources/active-probe/claude.ts,
    status-model.ts (full resolution logic)

NOT YET:
  - Codex (or any other provider)
  - CLI/MCP surfaces

VERIFIED BY:
  - Integration test: mock Claude responses drive passive observation correctly
  - Manual: watch a real Claude lane's status reflect an actual degraded/recovered
    state during this story's implementation

COMMIT REPRESENTS: First real, end-to-end health signal — one provider, fully wired

---

## Slice 4: Second Provider (Codex) — Proves the Pattern Generalizes

BUILDS ON: Slice 3, Slice 0 (spike)
WHAT WORKS AFTER THIS STEP:
  Codex lane status is real, using the same adapter pattern as Claude. Two
  providers now prove the ProviderSignalAdapter interface actually generalizes
  rather than being accidentally Claude-shaped.

LAYERS TOUCHED:
  Signal Detection: signal-sources/public-status/codex.ts,
    signal-sources/active-probe/codex.ts

NOT YET:
  - Gemini/OpenRouter/Kimi K3/Ollama (explicitly out of scope this epic)
  - CLI/MCP surfaces

VERIFIED BY:
  - Same test shape as Slice 3, applied to Codex
  - Any interface friction found here gets fixed in status-model.ts/lane-
    registry.ts rather than special-cased per provider

COMMIT REPRESENTS: Adapter pattern proven across two providers

---

## Slice 5: CLI + MCP Surfaces

BUILDS ON: Slice 3 (real signal data worth exposing via more surfaces)
WHAT WORKS AFTER THIS STEP:
  The same LaneRouterContract is now queryable via CLI (JSON + --format table)
  and as an MCP tool (heimdall.lanes.list), not just HTTP. All three surfaces
  return identical data from the same getLaneStatuses() core function.

LAYERS TOUCHED:
  Query Surfaces: api/cli.ts, api/mcp-server.ts

NOT YET:
  - SLA verification harness

VERIFIED BY:
  - Unit test: all three surfaces return identical shapes for the same underlying
    state (no drift between transports)
  - Manual: run the CLI query and the MCP tool call side by side against the
    HTTP response

COMMIT REPRESENTS: LaneRouterContract complete across all three transports

---

## Slice 6: SLA Verification Harness

BUILDS ON: Slice 3, Slice 4 (needs real signal behavior across ≥1 provider to measure)
WHAT WORKS AFTER THIS STEP:
  A synthetic test harness flips a mock lane's simulated health state and
  measures time-to-correct-query-response, verifying the 10-second SLA (REQ-06)
  is actually met by the layered signal model — not asserted, measured.

LAYERS TOUCHED:
  Verification: test/sla-harness/

NOT YET:
  - Nothing — this is the last slice in the epic. Uptime-history reporting
    beyond raw SQLite rows and any routing heuristic are explicitly P1+.

VERIFIED BY:
  - The harness itself IS the verification — it's a test, not a feature with
    a separate test

COMMIT REPRESENTS: v1 (P0) complete and SLA-verified
```

## 3. Overlay Diagram

```
VERTICAL SLICE OVERLAY
──────────────────────────────────────────────────────────────────────────────────
              │ Slice 0  │ Slice 1   │ Slice 2    │ Slice 3    │ Slice 4  │ Slice 5  │ Slice 6 │
              │ (spike)  │ (skeleton)│ (creds+db) │ (Claude)   │ (Codex)  │ (CLI/MCP)│ (SLA)   │
──────────────┼──────────┼───────────┼────────────┼────────────┼──────────┼──────────┼─────────┤
Skeleton      │          │ scaffold  │            │            │          │          │         │
──────────────┼──────────┼───────────┼────────────┼────────────┼──────────┼──────────┼─────────┤
Signal        │          │ status-   │ lane-      │ passive +  │ +codex   │          │         │
Detection     │          │ model     │ registry   │ pub-status │ adapters │          │         │
              │          │ (types)   │            │ +active-   │          │          │         │
              │          │           │            │ probe      │          │          │         │
              │          │           │            │ (claude)   │          │          │         │
──────────────┼──────────┼───────────┼────────────┼────────────┼──────────┼──────────┼─────────┤
Credential    │          │           │ .env/vault │            │          │          │         │
Loading       │          │           │ loader     │            │          │          │         │
──────────────┼──────────┼───────────┼────────────┼────────────┼──────────┼──────────┼─────────┤
State Storage │          │           │ SQLite     │            │          │          │         │
              │          │           │ schema     │            │          │          │         │
──────────────┼──────────┼───────────┼────────────┼────────────┼──────────┼──────────┼─────────┤
Query         │          │ GET       │            │            │          │ CLI +    │         │
Surfaces      │          │ /lanes    │            │            │          │ MCP      │         │
              │          │ (fixture) │            │            │          │          │         │
──────────────┼──────────┼───────────┼────────────┼────────────┼──────────┼──────────┼─────────┤
Verification  │          │           │            │            │          │          │ SLA     │
              │          │           │            │            │          │          │ harness │
──────────────────────────────────────────────────────────────────────────────────
Spike (Slice 0) gates the adapter-content cells in Slice 3 and 4 only — every
other cell is independent of it.
```

## 4. Deferred Items

```
DEFERRED (not in current slice plan):
  - Gemini, OpenRouter, Kimi K3, Ollama adapters — future epic, not part of v1's
    two-provider proof
  - Any routing/selection heuristic (P1) — Heimdall v1 only reports, never chooses
  - Standalone settings UI (P2), Portunus integration (P2) — per product-brief.md
  - Multi-instance coordination (GAP-03) — flagged, not designed for here

RATIONALE: All of these are explicitly out of P0 scope per product-brief.md and
  prd.md's Scope Boundaries section — safe to defer, not scope creep by omission.
```

## 5. Risk by Slice

```
RISK PER SLICE:
  Slice 0: Medium — the spike itself could surface an ugly signal shape that
    strains the adapter interface; that's the point of running it first.
  Slice 1: Low — pure scaffold + fixture, no real integration points.
  Slice 2: Low-Medium — first real I/O (file-based credentials, SQLite), but
    no external network calls yet.
  Slice 3: Medium-High — first real provider integration; where spike findings
    either hold up or don't.
  Slice 4: Medium — should be lower-risk than Slice 3 if the interface held up;
    a rough Slice 4 is itself a signal the interface needs revisiting.
  Slice 5: Low — no new business logic, just two more transports over an
    already-proven core function.
  Slice 6: Low-Medium — building a good synthetic harness for "time to correct
    status" is a bit of its own design problem, but it's isolated (test-only).
```

## 6. Moldability Notes

- Slice 1 and Slice 2 could be merged into one story if they end up small enough in practice — the boundary is drawn where it is mainly to isolate "does credential loading crash the service" as its own testable checkpoint.
- Slice 5 (CLI/MCP) could move earlier (right after Slice 1) if Mathew wants to start using the CLI against fixture data sooner — it doesn't strictly need real signal data to be built, only to be *useful*. Flagged as reorderable.
- Slice 4 (Codex) could be dropped from this epic without invalidating Slices 0-3, 5-6 if time runs short — the PRD's acceptance criteria are satisfied by proving the pattern on one provider plus a documented spike; a second provider strengthens confidence but isn't a hard requirement. Recommend keeping it, since "one provider" is a weaker proof that the interface generalizes.
- If Slice 0's findings reveal something that invalidates the `ProviderSignalAdapter` interface shape in architecture.md, Slices 3+ would need a design revisit before proceeding — this is the one point where a slice's outcome could ripple backward into an earlier decision, which is why Slice 0 runs first and alone.
