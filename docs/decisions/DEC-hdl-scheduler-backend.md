# DEC-hdl-scheduler-backend

**Status:** Accepted (2026-07-25)
**Supersedes:** the original P0 architecture note ("Scheduler (for REQ-03 sparse active checks): in-process interval timer + staleness check, not a separate cron/daemon") — that single-timer plan was decided before the `multica-native-no-box-runners` HARD LAW was surfaced and is no longer accurate.

Referenced by (kept in sync, not duplicated): `docs/scheduler-constraints.md`, `.pHive/planning/architecture.md`'s "Scheduler (post-P0)" section, `.pHive/cross-cutting-concerns.yaml`'s `no-box-daemon` and `argus-otel-emit` concerns.

## Decision

Each lane owns **two independent things**, not one shared timer:

1. **A health-check impl** — *how* the lane is checked. This is `LanePipeline.refresh(lane)` (lane-health-status epic) — **untouched by this decision**. The scheduler layer only decides *when* it's called.
2. **A scheduler impl** — *when/how often* `refresh(lane)` is called, chosen from exactly two sanctioned backends:

| Backend | Cadence | Role | Why it's HARD-LAW-compliant |
|---|---|---|---|
| `MulticaAutopilotScheduler` | cron, **≥1 min floor** | **Default**, coarse fleet-wide sweep. Registers (idempotently — checks by title, then by existing schedule trigger) a Multica autopilot that dispatches a real agent to call Heimdall's `POST /lanes/:laneId/refresh`. | It's Multica's own sanctioned cron primitive — not a box daemon Heimdall invented. |
| `InProcessScheduler` | ~5s | Fine SLA corroboration, **engaged only when a lane is degraded/down/out_of_credit**. Disengages (stops calling `refresh()`) immediately on recovery — the expensive work stops, though the cheap local status poll keeps running so re-degradation is still caught. | It's the service's own event loop, narrowly scoped to suspect lanes only — not a fleet of lanes each hammering a constant tick. |

**Banned:** any standalone box cron / launchd / shell-daemon ticker for this or any future recurring-execution need in Heimdall (`multica-native-no-box-runners` HARD LAW).

## Corrected during implementation (2026-07-25)

Direct inspection of the real, running Multica instance (authenticated CLI, live workspace) revealed the original plan's `trigger-add`-only model was wrong: registering a schedule is a **two-step** process — `multica autopilot create` (title, mode, agent, description) must exist before `multica autopilot trigger-add <real-server-assigned-id>` can add a cron trigger to it. `MulticaAutopilotScheduler` implements both steps idempotently (checks by title via `list`, checks for an existing schedule trigger via `get`, before calling `create`/`trigger-add`).

## Third interaction mode (additive, not a scheduling backend)

Beyond the two already-built query surfaces (agent-call/MCP, API-call/HTTP+CLI), this epic scaffolds a third: an **actuation stub** (`ActuationStub.onStatusChange`) that fires on a genuine lane status transition and records the intended future action ("would disable/re-enable this lane's Multica runtime") — **a stub only**, per explicit operator instruction. No real Multica runtime on/off API call is made; that contract doesn't exist yet and is future scope.

## Telemetry

Every tick (from either backend) and every status flip emits an OTLP span to **Argus** (Pantheon's observability god — confirmed live at Tailscale `100.75.161.82`, OTLP `4327` gRPC / `4328` HTTP, feeding Langfuse traces/cost + SigNoz infra) via `ArgusClient` — the first Node/TypeScript OTLP emitter in Pantheon. Fire-and-forget: Argus being unreachable never breaks Heimdall's core health-check function.

## What's still deferred

- Real Multica runtime on/off API calls (actuation stub stays a stub) — future epic, once that API/contract exists.
- Provisioning the actual Multica-side agent an autopilot dispatches — cross-repo, Multica's own concern.
- Gradual backoff curve for `InProcessScheduler` (immediate stop on recovery was chosen for v1).
- Wiring real Claude-Code-hook-sourced passive signals (e.g. capturing a live `529 Overloaded` error as it happens) into `LanePipeline`'s `lastPassiveResponse` — currently a stub returning `null`, flagged during this epic as a good next integration point.

## Consequences

- Every future recurring/background-execution need in Heimdall must justify itself against this same two-backend menu — a third backend requires a new decision record, not an ad hoc timer.
- `src/main.ts` is now the real service entrypoint (composes registry, store, Argus client, both scheduler backends per lane, the actuation stub, and the HTTP server with its new refresh-trigger route) — `npm run dev` runs it instead of `src/api/http-server.ts` directly.
