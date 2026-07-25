# Horizontal Planning Scan — Lane Health & Status

## 1. Layer Inventory

- **Service skeleton / project scaffold** — doesn't exist yet; the Node.js/TS project itself.
- **Signal detection** — the layered health-signal model (passive, public-status, active-probe) plus the 4-state resolution logic.
- **State storage** — SQLite current + historical lane status.
- **Credential loading** — local `.env`/vault stopgap behind a swappable interface.
- **Query surfaces (transport)** — HTTP, CLI, MCP — three thin wrappers over one core function (`LaneRouterContract`).
- **Verification harness** — synthetic SLA measurement (REQ-06).
- **Research spike** — REQ-00 per-provider signal inventory (not code, but gates two of the layers above).

## 2. Per-Layer Requirements

```
## Layer: Research Spike (REQ-00)

DELIVERABLE:
  - Written signal inventory for Claude + Codex: error codes observed, quota-reset
    signal format (if any), payment-failure signal format (if any), public
    status-endpoint machine-readability (structured vs. HTML-scrape)

GATES:
  - Blocks: Signal Detection layer's public-status + active-probe adapter CONTENT
    for Claude and Codex specifically (the generic interface is not gated)

---

## Layer: Service Skeleton

SCAFFOLD NEEDED:
  - package.json, tsconfig.json, basic src/ layout matching architecture.md's
    component tree
  - Local dev entrypoint (npm script to run the HTTP server)

---

## Layer: Signal Detection

INTERFACE (not gated by spike):
  - ProviderSignalAdapter interface (shared shape for public-status + active-probe
    adapters, per provider)
  - status-model.ts — 4-state resolution logic (REQ-04): up / down /
    out_of_credit (+ reset_at) / degraded
  - lane-registry.ts — loads configured lanes + their CredentialSource

ADAPTER CONTENT (gated by REQ-00 spike, Claude + Codex only):
  - signal-sources/passive.ts — last-response observation (REQ-01) — generic
    mechanism, not gated, but what it extracts per-provider is informed by the spike
  - signal-sources/public-status/{claude,codex}.ts (REQ-02)
  - signal-sources/active-probe/{claude,codex}.ts (REQ-03)

---

## Layer: State Storage

SCHEMA (from architecture.md):
  - lanes table (lane_id, provider, credential_ref)
  - lane_status_history table (lane_id, status, reset_at, reason, signal_source,
    observed_at) + idx_lane_status_latest index
  - state-store.ts — read/write, "current status = latest row per lane_id"

---

## Layer: Credential Loading

NEEDED:
  - credential-source.ts — CredentialSource interface
  - Local .env/vault implementation (REQ-07) — one entry per lane
  - Startup behavior: missing/invalid credential → lane reported down/unconfigured,
    not a service crash

---

## Layer: Query Surfaces (Transport)

ENDPOINTS/INTERFACES NEEDED:
  - GET /lanes (HTTP) — REQ-05 / LaneRouterContract, synchronous request/response
  - CLI query command (JSON + --format table) — same contract
  - MCP tool heimdall.lanes.list — same contract
  - All three call one shared getLaneStatuses() core function — no duplicated logic

---

## Layer: Verification Harness

NEEDED:
  - test/sla-harness/ — flips a mock lane's simulated health state, measures
    time-to-correct-query-response (REQ-06)
  - Unit tests for status-model.ts, state-store.ts, credential-source.ts
```

## 3. Cross-Layer Dependencies

```
DEPENDENCIES:

Signal Detection (adapter content, Claude/Codex) → Research Spike (REQ-00 findings)
Signal Detection (passive.ts generic mechanism) → Credential Loading (needs a
  real request to observe — but the mechanism itself doesn't need the spike)
Signal Detection (status-model.ts) → State Storage (writes resolved status)
Query Surfaces (all three) → Signal Detection + State Storage (read current status
  via one shared function)
Verification Harness → Signal Detection + State Storage (needs real state-flip
  behavior to measure against)
Everything → Service Skeleton (nothing runs without the project scaffold existing)
```

## 4. Layer Map Diagram

```
HORIZONTAL LAYER MAP
─────────────────────────────────────────────────────────────────────
Skeleton    │ package.json/tsconfig  │                                │
            │ (scaffold, no gate)    │                                │
────────────┼────────────────────────┼────────────────────────────────┤
Spike       │ REQ-00 inventory       │ (gates adapter content below)  │
            │ (Claude + Codex)       │                                │
────────────┼────────────────────────┼────────────────────────────────┤
Signal      │ status-model.ts        │ passive/public-status/active-  │
Detection   │ lane-registry.ts       │ probe adapters (Claude, Codex) │
            │ (interface, no gate)   │ (gated by spike, per-provider) │
────────────┼────────────────────────┼────────────────────────────────┤
Credential  │ credential-source.ts   │                                │
Loading     │ + local .env/vault     │                                │
────────────┼────────────────────────┼────────────────────────────────┤
State       │ SQLite schema          │ state-store.ts read/write      │
Storage     │ (lanes, history)       │                                │
────────────┼────────────────────────┼────────────────────────────────┤
Query       │ GET /lanes (HTTP)      │ CLI + MCP (same core function) │
Surfaces    │                        │                                │
────────────┼────────────────────────┼────────────────────────────────┤
Verification│ SLA harness            │ unit tests per layer            │
─────────────────────────────────────────────────────────────────────
```

## 5. Scope Summary

```
HORIZONTAL SCOPE:
  Layers affected: 6 (skeleton, spike, signal detection, credential loading,
    state storage, query surfaces) + verification
  Total items: ~18 (counting spike deliverable, interfaces, 2 provider adapter
    pairs, schema, 3 transports, harness)
  New vs modified: all new (greenfield)
  Estimated total effort: medium

  LARGEST LAYER: Signal Detection (interface + 2 full adapter pairs)
  RISKIEST LAYER: Signal Detection's adapter content — entirely dependent on
    REQ-00 spike findings, which are the one real unknown in this epic
```
