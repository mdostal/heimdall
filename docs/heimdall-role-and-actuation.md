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

## Integration adapters — TWO kinds (this is the key distinction)

Mathew (2026-07-25): *"heimdall is supposed to health check + control route… our
integration control is multica, we add one for standalone in agent harnesses, and
api and stub for another multica-like instance."* The adapters are **not all the
same** — they differ by how much control Heimdall exerts, which depends on whether
the substrate's agents **persist**:

### (1) CONTROL adapters — enable/disable persistent agents

Where agents **live in the substrate and are not spun up per-task**, Heimdall's job
is to **enable/disable** them on a lane health flip. This is the real "control route."

- **`MulticaControlAdapter` (primary, BUILD FIRST).** In Multica the agents are
  persistent — *"those agents aren't spun up but live in multica and we need to
  enable / disable."* On a lane flip, Heimdall calls Multica's REST control API.
  **Verified levers:**
  - `PUT /api/agents/{id}` (`agent update`): `--model <fallback>` (swap opus→haiku
    when a lane is capped), `--max-concurrent-tasks 0` (disable) / `N` (enable/scale),
    `--status` (pause/active), `--visibility private|workspace` (private =
    undispatchable — cf. dispatch-403).
  - `POST /api/agents/{id}/archive` + `/restore` (hard off/on).
  - **Runtimes = workstations/runners** (`agent_runtime`: status/provider/last_seen)
    — turn a runner on/off via its agents.
  - Behavior: lane `down`/`out_of_credit` → disable/downshift the bound agents;
    recovers → re-enable. (Optionally fronted by autopilot webhook
    `POST /api/webhooks/autopilots/{token}`; direct REST is cleaner.)
- **`StubControlAdapter` (placeholder).** A stub for *another Multica-like
  instance* — a different persistent-agent orchestrator. Same enable/disable shape;
  fill in when/if one exists. Keeps the control interface substrate-neutral.

### (2) ADVISORY adapters — health-check + calls (consumer routes its own)

Where agents are **ephemeral** (the consumer spins them up per task), Heimdall does
**not** enable/disable anything — it just answers "which lane is healthy / where
does this go," and the consumer routes. Routers can be added incrementally.

- **`HarnessAdapter` (MCP / skillset).** *"For a harness it would just be the health
  check and calls."* Heimdall's v1 MCP server — a Claude-Code-style harness asks
  "give me a healthy lane" before dispatch. Advisory only.
- **`ApiAdapter` (HTTP).** *"similar — a health checker to know where things go, and
  we can add the routers as we go."* v1 HTTP surface; incremental routing on top.

**One gateway, two adapter kinds.** Control (persistent substrates: Multica + the
stub) vs advisory (ephemeral consumers: harness + API). Same health core feeds both.

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

Heimdall is the **one gateway** = **health-check + control-route**. The integration
is pluggable, in two kinds:
- **Persistent substrate (Multica, + a stub for Multica-likes)** → CONTROL adapter:
  Heimdall enable/disables the agents/runners that live there on lane health flips.
- **Ephemeral consumer (agent harness, API)** → ADVISORY adapter: Heimdall answers
  "which lane is healthy / where does this go"; the consumer routes; add routers
  incrementally.

Heimdall never runs the work or replaces Multica dispatch — it senses lane health
and, where agents persist, actuates them. Same per-lane sense core feeds both kinds.

**v2 scope / build order:** v1 sense is done. v2 = the integration layer. Build
**`MulticaControlAdapter` FIRST** (the real control, against the verified endpoints
above), then the `HarnessAdapter` (MCP) + `ApiAdapter` (HTTP) as advisory wrappers
over the same health core, and a `StubControlAdapter` placeholder for another
Multica-like substrate. The scheduler drives the sense loop; on a persistent
substrate a status flip fires the control adapter.
