# Heimdall — Vision

Heimdall is the **health-aware lane gateway** for [Pantheon](https://github.com/mdostal/pantheon-v2).
This document is the trajectory: where it is now, what's next, and where it grows
to. Contributors can pick a rung and jump in.

A lane is a `provider × account × runtime` triple — `claude@mathew.dostal`,
`claude@dostalmathew`, `codex`, `gemini-3-pro`, `openrouter/grok`, `ollama-local`
— each with its own long-lived credentials. Heimdall's job is to know which lanes
are healthy and to act on that knowledge.

---

## ① Current — where it is (v0.4.0)

Heimdall runs as a headless Node/TypeScript service on **`http://localhost:4870`**
(override with `PORT`). Three epics have shipped and everything below actually
runs today:

**Sensing (`lane-health-status`, shipped).**
- Resolves every lane to one of four states — `up`, `down`, `out_of_credit`,
  `degraded` — via `resolveStatus()` in `src/core/status-model.ts`, a pure
  function that never throws on malformed input.
- Three layered signal sources: `passive` (observed traffic), `public_status`
  (piggybacking a provider's status page), and `active_probe` (a sparse, cheap
  real call — because a `--version` isn't proof a lane is alive). A corroboration
  policy guards against provider false-positives. Adapters exist for **Claude and
  Codex** lanes today.
- State persists to a **`node:sqlite`** store (`HEIMDALL_DB_PATH`, default
  in-memory).
- One `LaneRouterContract` exposed identically over **HTTP** (`GET /lanes`),
  **CLI** (`npm run cli`), and **MCP** (`heimdall.lanes.list`) — all synchronous,
  all calling the same core.
- SLA-verified: status correctness within 10 seconds of an actual state change,
  *measured* by `test/sla-harness/`, not asserted.

**Scheduling (`hdl-scheduler`, shipped).**
- Pluggable per-lane `Scheduler` interface with two backends:
  `MulticaAutopilotScheduler` (default, coarse cron registered as a **Multica
  autopilot** — honoring the "no local box runners" rule, ≥1 min floor) and
  `InProcessScheduler` (fine ~5 s, suspect-lanes only, backs off on recovery).
- `POST /lanes/:laneId/refresh` is the on-demand trigger the dispatched Multica
  agent calls when a lane's autopilot fires.
- Every tick and status flip emits **OTEL to Argus** (Pantheon's first
  Node/TypeScript OTLP client).

**Actuation (`hdl-actuation`, shipped).**
- `MulticaControlAdapter` calls Multica's real REST API to disable/re-enable a
  lane's mapped agents by setting `max_concurrent_tasks` to `0`/`N` (the
  verified-safe lever), through a timeout-hardened `MulticaRestClient` wrapped in
  a `CircuitBreaker`.
- Lane → agent mapping is explicit config
  (`HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS`) behind a `LaneAgentResolver`. Mapped
  lanes get the real adapter; everything else — including the whole service when
  Multica isn't configured — falls back to a **loud `StubControlAdapter`**, never
  a silent no-op.
- `reconcile()` runs every sense-loop tick for every lane → idempotent
  retry-for-free on partial failures; every attempt is emitted to Argus.

**Honest stubs / gaps.**
- Actuation is tested **entirely against local mocks**. The real hive Multica
  instance (`:8090`) is never called by the test suite — **live end-to-end
  verification is an explicit operator follow-up**, not done.
- Credentials come from **local env vars** (`.env`), a deliberate stopgap ahead
  of Portunus.
- `ActuationStub` in the scheduler layer marks a third interaction mode (future
  Multica runtime on/off toggling) that is scaffolded, not wired.
- Only **Claude and Codex** signal adapters exist; other providers are vision,
  not code.
- There is **no routing decision** yet — Heimdall reports and actuates on health;
  it does not yet choose a lane for a task.

---

## ② Goals — near-term next steps

- **Live end-to-end actuation verification** against the real hive Multica
  (`:8090`) — close the mocks-only gap with an operator-run smoke test.
- **Per-lane scheduler / health-probe tuning:** smarter probe cadence driven by
  recent state (probe suspect lanes harder, healthy lanes rarely) to minimize
  spend while keeping the 10-second correctness SLA.
- **More provider adapters** beyond Claude/Codex — Fable, Gemini, OpenRouter,
  Ollama — each behind the same signal-source interface.
- **Headroom tracking:** move past binary up/down to per-lane remaining
  weekly/usage capacity, so routing can spread load instead of just avoiding dead
  lanes.
- **The light standalone settings UI:** sign up new agents/runtimes, add
  runtimes, and *see and verify* them — the standalone-only surface (in Pantheon
  this config lives through Vesta/Multica).

---

## ③ Long-term vision

Heimdall grows from a health **gateway** into a full **health-aware router**: the
component Auriga calls on every dispatch — input `{task-type, est-cost,
constraints}`, output `{chosen lane + creds handle}`.

- **Full multi-lane token routing.** Every runner is used, routed by *live
  health* and headroom — premium/architecture work to Claude/Fable, bulk/grunt to
  cheaper lanes, images to the right image model, and never real feature work to a
  distrusted cheap tier. On rate-limit, **swap lanes, don't halt; recover, don't
  recreate.**
- **An SLA harness as a first-class product surface,** not just a test:
  continuously proving that routing decisions honor per-lane correctness and
  latency guarantees.
- **Per-account long-lived tokens via Portunus** — the prerequisite that makes
  cross-account sharing real. Minting and storing them harness-side is blocking
  for cross-account routing and is tracked as a dependency, not owned here.
- **Two distribution modes, always.** Like every Pantheon god, Heimdall is
  open-source and ships **standalone** (carrying its own light config UI, usable
  from any harness that can spin up multiple agents) *and* as a **Pantheon
  plugin** (config through Vesta/Multica). Same core, two front doors.

Platform-wide, this rides Pantheon's core principle: **everything is swappable.**
Any language, model, plugin, or god can be toggled on/off and compared on metrics
at every step — Heimdall is exactly the god that makes "compare lanes on live
health and cost, then route" a first-class, measurable operation.

---

## Good first contributions

- **Add a provider signal adapter** (e.g. Gemini or OpenRouter): implement the
  `public_status` + `active_probe` sources following
  `src/core/signal-sources/*/claude.ts` as the template.
- **Widen the CLI `--format table`** output or add a `--watch` mode over the
  existing `getLaneStatuses()` core.
- **Extend the SLA harness** (`test/sla-harness/`) with new state-transition
  scenarios.
- **Tighten `InProcessScheduler` back-off** heuristics so suspect lanes get
  probed more and recovered lanes fewer.
- **Document a real Multica actuation runbook** from `.env.example` — the safe
  operator path to the first live end-to-end toggle.
- **Harden `resolveStatus()`** against additional malformed-signal shapes with
  new table-driven tests in `src/core/status-model.test.ts`.

New to the codebase? Start at `src/main.ts` (`composeService()`) — it wires every
piece together and is the fastest map of how sensing, scheduling, and actuation
compose into the running service.
