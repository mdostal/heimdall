# Heimdall — role + actuation (THE answer)

Resolves the "what is Heimdall, exactly?" confusion. Verified against Multica's
control API (`~/Documents/work/dostal/code/multica`, 2026-07-25). Decision of
record: `DEC-hdl-role-actuation`.

## Heimdall IS: the lane GATEWAY — sense **and** actuate. NOT a dispatcher.

Heimdall is the single authority on lane health **and** the thing that turns lanes
on/off in whatever substrate executes work. It does **not** run agents and does
**not** replace Multica's dispatch — it *tells the substrate what to enable/disable*.

Two halves:

- **SENSE (v1 — DONE):** per-lane health (`up | down | out_of_credit | degraded`)
  via per-lane signal adapters (passive → public-status → active-probe), queryable
  through `LaneRouterContract` over HTTP / CLI / MCP.
- **ACTUATE (v2):** turn lanes on/off in the *active* substrate via per-substrate
  **actuator adapters** — the same pluggable pattern as the signal adapters, just
  the write side. The seam already exists: `src/core/lane-pipeline.ts:42`
  ("no agent traffic routes through Heimdall yet — real callers wire this up").

## Actuator adapters — the three surfaces you named, all validated

Mathew (2026-07-25): *"when multica is there it auto turns on and off as a multica
plugin OR could be a direct mcp / skillset for an agent harness OR could be routed
through an API."* All three are viable; they are actuator adapters behind one gateway:

1. **`MulticaActuator` (primary — when Multica is the substrate).** On a lane
   health flip, Heimdall calls Multica's REST control API to enable/disable the
   agents/runtimes bound to that lane. **Verified levers:**
   - `PUT /api/agents/{id}` (`agent update`): `--model <fallback>` (swap
     opus→haiku when a lane is capped), `--max-concurrent-tasks 0` (disable) / `N`
     (enable/scale), `--status` (pause/active), `--visibility private|workspace`
     (private = undispatchable — cf. the dispatch-403 rule).
   - `POST /api/agents/{id}/archive` + `/restore` (hard off/on).
   - **Runtimes = the workstations/runners** (`agent_runtime`: status, provider,
     last_seen_at) — turn a runner on/off by controlling its agents.
   - Behavior: lane `down`/`out_of_credit` → disable/downshift the bound agents;
     lane recovers → re-enable. This IS "the Multica plugin that turns runners on
     and off." (Optionally fronted by a Multica autopilot webhook
     `POST /api/webhooks/autopilots/{token}`, but the direct REST call is cleaner.)
2. **`HarnessActuator` (MCP / skillset).** Heimdall's MCP server (already shipped
   in v1) — a Claude-Code-style harness asks "give me a healthy lane" before
   dispatch (pull mode), and can call Heimdall to flip a lane.
3. **`ApiActuator` (HTTP).** The v1 HTTP surface — any other consumer routes
   through it.

## Lane → Multica mapping

A **lane** = provider + model (e.g. `claude / opus-4.8`). Multica agents carry a
`--model` and sit on a runtime with a `provider`. Heimdall lists the Multica
agents/runtimes on a given lane and acts on them. Wiring: Heimdall's lane registry
↔ a Multica agent/runtime lookup by provider/model.

## Where the scheduler fits ([[scheduler-constraints]])

The per-lane **scheduler** (specced, commit `87a9c4a`) drives the SENSE loop
(`refresh(lane)`). On a status flip, the **actuator** fires. Full pipeline:

```
scheduler tick → refresh(lane) → status change → actuator adapter → substrate
   (per-lane cadence)   (v1 health)    (up/down/…)   (Multica | MCP | API)
```

## Substrate-agnostic gateway (the one-line answer)

Heimdall is the **one gateway**; the **actuator is pluggable per substrate**:
- **Multica present** → `MulticaActuator` auto on/off (agents/runtimes).
- **Bare agent harness** → MCP / skill.
- **Neither** → HTTP API.

Heimdall never runs the work or replaces Multica dispatch — it senses lane health
and actuates the substrate. This fits the existing per-lane adapter architecture
exactly: signal adapters in, actuator adapters out.

**v2 scope note:** v1 routing was deferred; this doc defines v2 = the actuator
layer (Multica adapter first) driven by the v1 sense loop + the scheduler. Build
the `MulticaActuator` against the verified endpoints above; keep `HarnessActuator`
(MCP) and `ApiActuator` as thin wrappers over the same enable/disable core.
