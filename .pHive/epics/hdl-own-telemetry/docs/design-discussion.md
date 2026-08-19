# Design Discussion — hdl-own-telemetry

## 0. Prelude

Operator directive (2026-08-14), in response to my proposal to add Argus OTEL
emission for routing decisions: *"heimdall should have it's own telemetry and
stuff, we need to be working completely in a silo -- we will tie the metric
tracking to the pantheon and let it bubble up, but each god needs its own
metric tracking done separately -- argus is just another silly dashboard for
otel alike posthog or anything else."*

## 1. The actual gap

Audited every current Argus emission call site
(`src/core/actuation/multica-control-adapter.ts`'s `emitActuationResult`,
`in-process-scheduler.ts`/`multica-autopilot-scheduler.ts`'s `emitTick`/
`emitStatusFlip`). `ArgusClient` is already fire-and-forget and never breaks
Heimdall if unreachable — that part is fine. The real gap: **actuation
results, rotation events, and model substitutions have zero local record.**
They exist only as OTEL spans pushed to Argus. If Argus isn't running (or a
standalone-mode operator never configured it — the common case, since
`.env.example` has no Argus requirement), that data is simply gone. Lane
status flips (`lane_status_history`) and routing decisions
(`routing_decisions`/`routing_outcomes`, from `hdl-rr-03`) already ARE
recorded locally — those two are fine as-is.

## 2. Approach

**Argus stops being the source of truth for anything.** It becomes one
optional downstream consumer of facts Heimdall already knows about itself —
exactly the "just another OTEL dashboard, like PostHog" framing. Concretely:

- New `telemetry_events` table on `StateStore` — covers the three event
  kinds with no existing local record: `actuation_result`, `rotation_event`,
  `model_substitution`. (Status flips and routing decisions already have
  dedicated tables; no need to duplicate them here.)
- `LocalTelemetryRecorder implements ArgusEmitter` — same 3-method interface
  `ArgusClient` already implements, writing to `telemetry_events` instead of
  emitting OTEL. `CompositeTelemetryEmitter implements ArgusEmitter` fans out
  to both `[local, argus]`. **One-line change at the construction site**
  (`composeService()`): `new ArgusClient()` becomes
  `new CompositeTelemetryEmitter([new LocalTelemetryRecorder(store), options.argus ?? new ArgusClient()])`
  — every existing call site keeps its `ArgusEmitter`-typed parameter
  unchanged, since a composite satisfies the same interface. This is
  deliberately NOT a rip-and-replace of Argus — Argus keeps receiving the
  exact same spans it does today; Heimdall just stops depending on it.
- `RotationController` and `route-selector.ts` already hold a direct
  reference to `StateStore` — no new abstraction needed there. Each calls
  `store.recordTelemetryEvent(...)` inline at the point it already computes
  the fact (`markCapped`/`rotateToNextHealthy`; the `substituted` branch in
  `resolveEffectiveModel`'s caller).
- `GET /metrics` — Prometheus text exposition format (industry-standard,
  scrapable by Argus/Grafana/Prometheus/anything later without Heimdall
  depending on any of them being present). Aggregates: `telemetry_events`
  counts by type+label, current lane status gauge (from the existing
  `getAllCurrentStatuses()` — already local), routing-decision counts (new
  `RouteLedger.getDecisionCounts()` method), model-catalog enabled/disabled
  counts (already local). Hand-rolled text formatting — no new dependency;
  matches this codebase's established "no framework, no build step" bar
  (the dashboard already sets this precedent).
- Dashboard gets a small "Telemetry" panel — recent event counts, loaded
  once like the routing-strategy/model-catalog panels (a summary view, not
  a live-polled one).

## 3. What this deliberately does NOT do

Does not remove or reduce Argus emission — Pantheon-wide observability via
Argus (or any other OTEL consumer) keeps working unchanged; it's additive,
not migrated. Does not add a metrics *export* pipeline (Prometheus remote
write, OTLP metrics, etc.) — `GET /metrics` being scrapable is sufficient for
"bubble up to Pantheon" later; building an active push pipeline is
unrequested scope. Does not persist raw scheduler ticks (`emitTick`) locally
— high-frequency, low-value as individual rows; `lane_status_history` already
captures every status *observation*, which is the meaningful record.

## 4. Scale assessment

Medium — one new table, a thin recorder/composite pair, three new inline
recording call sites, one new endpoint, one dashboard panel. No architecture
redesign (unlike hdl-routing-reconciliation).
