# Heimdall — Architecture (v1 / P0)

Source: `.pHive/planning/prd.md`. Covers REQ-00 through REQ-07.

> **Gating note:** REQ-00 (per-provider signal inventory spike) has **not** been run yet. Everything below that depends on per-provider signal specifics (the adapter layer, staleness thresholds — GAP-01) is deliberately left pluggable/provisional rather than fully decided, so the spike's findings can slot in without a redesign. Everything else (service shape, API contract, data model, deployment) is decided now since it doesn't depend on spike findings.

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language/runtime | **Node.js + TypeScript** | Matches the Pantheon/Hive ecosystem (plugin-hive's own `hive/lib/` is Node/TS+.mjs throughout); lets Heimdall ship as both a standalone CLI/service *and* an MCP server with no cross-language bridge. |
| Service interface | **Local HTTP endpoint (default) + CLI** — resolves PRD GAP-02 | HTTP for programmatic consumers (Auriga, future UIs); CLI for Mathew's manual "what's healthy right now" checks. Both are thin wrappers over the same core query function — no logic duplication. |
| Pantheon-mode interface | **MCP server** exposing the availability-query tool (REQ-05) | Lets any Claude-Code-based orchestrator (Auriga, or Mathew directly) call Heimdall as a tool with zero custom integration glue — this is the most natural "plug into Pantheon" surface given the ecosystem. |
| State storage | **SQLite (local file, e.g. `~/.heimdall/state.sqlite`)** | Local-first, zero external dependency, matches the `~/.claude/hive/kg.sqlite` precedent already used elsewhere in this ecosystem. Holds per-lane status history, not just current state — needed for REQ-06 SLA verification and future uptime visibility (secondary success metric). |
| Credential loading | **Local `.env` / simple vault file (REQ-07)**, one entry per lane | Deferred-Portunus stopgap per PRD; a thin `CredentialSource` interface so swapping in Portunus later (P2) doesn't touch calling code. |
| Scheduler (for REQ-03 sparse active checks) | **SUPERSEDED post-P0 → pluggable, per-lane `Scheduler` interface** (see "Scheduler (post-P0)" section below and `docs/scheduler-constraints.md`). P0 shipped with `refresh()` invocable but no ticker; the post-P0 epic adds a Multica-autopilot cron backend (default, coarse ≥1min) + an in-process backend (fine ~5s, suspect-lane only). | The original "single in-process interval timer" plan is **superseded** by `DEC-hdl-scheduler-backend`: the `multica-native-no-box-runners` HARD LAW bars a standalone box cron/daemon, and per-lane cadences differ (status-page poll vs port ping vs suspect-lane 5s corroboration). Each lane owns its own check impl AND its own scheduler impl. |

**Alternatives considered:**
- *Python* — rejected: no natural MCP-server story as clean as Node's, and would fragment the toolchain from the rest of Hive/Pantheon tooling which is Node-centric.
- *Postgres/external DB* — rejected: violates the local-first/self-hosted constraint from discovery; SQLite is sufficient at this scale and adds zero ops burden.
- *Wrapping LiteLLM as the core* — rejected per discovery brief's competitive-landscape finding: LiteLLM solves request-proxying, not "expose lane health as a queryable API for an external orchestrator." Revisit only if P1's routing heuristic wants a proxying layer.

## Components

```
heimdall/
  src/
    core/
      status-model.ts       # REQ-04: 4-state resolution logic (up/down/out_of_credit/degraded)
      lane-registry.ts       # loads configured lanes + their CredentialSource
      signal-sources/
        passive.ts           # REQ-01: last-response observation
        public-status.ts      # REQ-02: provider status-page piggyback (per-provider adapter, PROVISIONAL pending REQ-00)
        active-probe.ts       # REQ-03: sparse active light check (per-provider adapter, PROVISIONAL pending REQ-00)
      credential-source.ts   # REQ-07: local .env/vault loader behind a swappable interface
      state-store.ts          # SQLite read/write for current + historical status
    api/
      http-server.ts          # REQ-05: local HTTP endpoint
      cli.ts                  # REQ-05: CLI query surface
      mcp-server.ts            # Pantheon-mode MCP tool exposing the same query
  test/
    sla-harness/               # REQ-06: synthetic health-flip -> time-to-correct-response measurement
```

Each provider (Claude, Codex, Gemini, OpenRouter, Kimi K3, Ollama, …) gets one adapter module under `signal-sources/public-status/` and `signal-sources/active-probe/` implementing a shared `ProviderSignalAdapter` interface. **Only Claude and Codex adapters get built for the REQ-00 spike** — the interface is designed now, but adapter *content* per-provider is what the spike informs.

## API Contract (REQ-05) — `LaneRouterContract`

**Binding shape:** synchronous request/response on all three surfaces (HTTP, CLI, MCP) — never fire-and-forget. A caller's query returns the answer directly; there is no "subscribe and wait for a later event" path. This is named and gated explicitly per operator note (2026-07-25) applied across Pantheon: a fire-and-forget specialist shape cannot answer "any free lane?" — the caller needs an answer in the same call.

```
GET /lanes
→ 200 OK
[
  {
    "lane_id": "claude@mathew.dostal",
    "provider": "claude",
    "status": "up" | "down" | "out_of_credit" | "degraded",
    "reset_at": "2026-07-26T00:00:00Z" | null,
    "reason": "string | null",
    "last_updated": "ISO8601",
    "signal_source": "passive" | "public_status" | "active_probe"
  },
  ...
]
```

Same shape returned by the CLI (as JSON, or a formatted table with `--format table`) and the MCP tool (`heimdall.lanes.list`). One core function (`getLaneStatuses()`) backs all three surfaces — no duplicated logic per PRD's "never crash the whole service" (REQ-07) and "empty result, not an error" (REQ-05) requirements.

## Data Model

```sql
-- state-store.ts (SQLite)
CREATE TABLE lanes (
  lane_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  credential_ref TEXT NOT NULL  -- key into local .env/vault, never the secret itself
);

CREATE TABLE lane_status_history (
  lane_id TEXT NOT NULL REFERENCES lanes(lane_id),
  status TEXT NOT NULL CHECK (status IN ('up','down','out_of_credit','degraded')),
  reset_at TEXT,
  reason TEXT,
  signal_source TEXT NOT NULL CHECK (signal_source IN ('passive','public_status','active_probe')),
  observed_at TEXT NOT NULL
);
CREATE INDEX idx_lane_status_latest ON lane_status_history(lane_id, observed_at DESC);
```

Current status = latest row per `lane_id` in `lane_status_history`. History is retained for SLA verification (REQ-06 test harness) and future uptime-visibility reporting (secondary success metric) — not just overwritten in place.

## Scheduler (post-P0) — pluggable, per-lane

**Decision of record:** `DEC-hdl-scheduler-backend` (Pantheon decision-log). Full hard
constraints in [`docs/scheduler-constraints.md`](../../docs/scheduler-constraints.md).
P0 shipped `LanePipeline.refresh()` invocable-but-unticked on purpose; this section is
the binding input for the "pluggable per-lane Scheduler" epic.

**Core principle — PER-LANE.** Each lane owns **two** impls, not one shared timer:
1. **Health-check impl** — *how* the lane is checked (reuses the layered
   `passive → public-status → active-probe` sources, composed per-lane: status-page
   poll for Claude/Codex, port/`/health` ping for local Ollama, passive+sparse-probe
   where there's no public page).
2. **Scheduler impl / cadence** — *when/how often* `refresh(lane)` is called.

`refresh()` stays UNTOUCHED — the scheduler only decides *when*. **Heimdall stays the checker.**

**Backends each lane selects from:**
- **`MulticaAutopilotScheduler` (DEFAULT, coarse ≥1min):** a Multica autopilot
  `--kind schedule --cron` fires Heimdall's refresh (CLI/HTTP). Native, zero new box
  daemon, HARD-LAW-compliant. Cron floor = 1 minute.
- **`InProcessScheduler` (fine ~5s, suspect-lane only):** Heimdall's own service event
  loop — engaged ONLY when a lane goes suspect/degraded (SLA harness needs 2 signals
  inside a 10s window; cron can't go sub-minute), and **backs off when the lane is
  healthy.** Legit because it is the service's own loop, NOT a standalone cron/launchd/
  shell daemon. ⚠ Scope this tight — a fleet of lanes each hammering a constant 5s tick
  is exactly the self-racing load the HARD LAW exists to prevent.

**Emit to Argus over OTEL** — every tick + status-flip → OTLP (`4327/4328`) → Langfuse
(traces/cost) + SigNoz (infra). Satisfies the decisions+metrics mandate and gives
lane-health a dashboard with no UI built here. SQLite history stays; Argus gets the stream.

**Build-vs-buy (scanned 2026-07-25):** Argus is observability (telemetry/cost), NOT
lane-probing — no duplication; Multica autopilots are the sanctioned cron primitive
(reused); provider-lane liveness is genuinely Heimdall's. **Banned:** any standalone box
cron/launchd/shell-daemon ticker.

## Open Items Deferred to Post-Spike Design Pass

- **GAP-01** (staleness threshold for REQ-03): left as a configurable per-adapter value, default TBD until REQ-00 findings exist.
- **GAP-02** (CLI vs. HTTP vs. both): resolved above — both, backed by one core function.
- **GAP-03** (multi-instance coordination): out of scope for P0; single SQLite file assumes single coordinating instance. Flag for P1 if Mathew's fleet grows to needing >1 Heimdall instance before a routing heuristic ships.

## Next Step

Run the REQ-00 gating spike (Claude + Codex signal inventory) before writing `ProviderSignalAdapter` implementations. Everything else in this architecture can be scaffolded in parallel (service skeleton, API contract, data model, credential loading) since none of it depends on the spike's findings.
