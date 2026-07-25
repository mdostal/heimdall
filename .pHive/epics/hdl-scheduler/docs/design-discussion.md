# Design Discussion — Pluggable Per-Lane Scheduler (hdl-scheduler)

## 1. What Are We Doing?

Heimdall's v1/P0 build (`LanePipeline.refresh(lane)`) is fully working but has nothing calling it periodically — it's invocable but unticked. This epic adds the *when/how-often* layer: a pluggable `Scheduler` interface, with each lane independently choosing between two backends — a coarse Multica-autopilot cron (default, ≥1min floor) and Heimdall's own fine in-process ticker (~5s, engaged only when a lane goes suspect/degraded, to satisfy the SLA harness's corroboration-needs-2-signals finding). Every tick and status-flip emits OTEL to Argus. `refresh()` itself does not change — this is purely the scheduling layer wrapped around it. Done means: lanes actually get checked on a real cadence, without Heimdall running its own standalone cron/daemon (the `multica-native-no-box-runners` HARD LAW), and every check is externally visible via Argus/Langfuse/SigNoz with no UI built here.

## 2. What I Found

- `docs/scheduler-constraints.md`, `.pHive/planning/architecture.md`'s "Scheduler (post-P0)" section, and `.pHive/cross-cutting-concerns.yaml`'s two new concerns are **binding inputs**, not proposals — they supersede the original P0 architecture's "single in-process interval timer" plan (`DEC-hdl-scheduler-backend`).
- Direct repo inspection confirmed Multica is real (`/Users/mdostal/Code/multica`), the cron floor is exactly 1 minute, and — critically — an autopilot trigger dispatches an **agent**, not a bare shell command (`multica autopilot trigger-add <id> --kind schedule --cron ... ` with `mode: run_only, agent: <name>`). This is more involved than "cron calls curl."
- Argus is real but remote (Tailscale host, not a local repo); the OTLP ports in the constraints doc (4327/4328) check out exactly. No Node/TS OTEL client exists in Pantheon yet — this epic authors the first one, using the standard `@opentelemetry/*` SDK.
- `monitoring/src/patterns/BackoffStrategy.js` is a reusable *pattern* (pure delay-calculator) for the in-process ticker's "backs off when healthy" behavior — not directly importable (different package), but worth mirroring.
- Full findings: `.pHive/epics/hdl-scheduler/docs/research-brief.md`.

## 3. My Proposed Approach

1. **`Scheduler` interface first** (`src/core/scheduler/scheduler.ts`) — `start()`/`stop()`, provider-agnostic, no backend-specific logic. This is what makes the two backends genuinely swappable rather than hardcoded.
2. **`MulticaAutopilotScheduler`** — on `start()`, shells out to `multica autopilot trigger-add` (via Node's `child_process`, injectable for testing) to register/ensure a cron-driven autopilot exists for a lane. Needs a small dispatched-agent counterpart (or reuse of an existing generic "run a command" Multica agent, if one exists — open question below) whose job is to call Heimdall's own CLI/HTTP refresh trigger.
3. **`InProcessScheduler`** — a per-lane timer (setTimeout-recursion, not literally `setInterval`), engaged only when `StateStore.getCurrentStatus(lane).status` is `degraded`/`down`/`out_of_credit`, ~5s cadence, backing off (mirroring `BackoffStrategy.js`'s pattern) once the lane recovers to `up`. Overlap-guarded and error-isolated (one bad tick must not wedge the loop) — same invariants as the (abandoned) naive design I almost built, just scoped narrowly to suspect lanes only instead of being the default for everything.
4. **Argus OTEL client** (`src/core/telemetry/argus-client.ts`) — thin wrapper over `@opentelemetry/sdk-node` + OTLP exporters (gRPC to 4327, or HTTP to 4328), emitting one span/metric per tick and per status-flip. New dependency, isolated behind a small interface so it's mockable in tests (Heimdall must not require a live Argus connection to pass its test suite).
5. **`DEC-hdl-scheduler-backend`** decision record — formalize what's currently scattered across 3 files into one authoritative doc at `docs/decisions/DEC-hdl-scheduler-backend.md`.
6. **Per-lane scheduler assignment** — extend `LaneRegistry`/config so each lane can declare which backend(s) it uses (all lanes get `MulticaAutopilotScheduler` by default; `InProcessScheduler` engages dynamically based on status, not per-lane config).

## 4. What Could Go Wrong

- **[High] The Multica-autopilot-dispatches-an-agent shape is still an open question** (see Open Questions #1) — if the answer turns out to require a heavier custom agent than "call Heimdall's CLI," this could expand scope significantly. Mitigation: raise it explicitly now rather than assume; the vertical plan sequences this as an early, small spike-like slice so the answer arrives before the rest of the Multica backend is built.
- **[Medium] Building the first Node/TS Argus OTEL client in Pantheon means there's no prior art to copy exactly.** Mitigation: use the official `@opentelemetry/*` SDK (well-documented, standard), not a bespoke OTLP implementation — reduces the "first of its kind" risk to configuration, not protocol-level work.
- **[Medium] `InProcessScheduler`'s "only for suspect lanes, backs off when healthy" behavior is exactly the kind of thing that could accidentally regress into "ticks everything all the time" if the engage/disengage logic has a bug.** Mitigation: this is the HARD LAW's specific concern (constraints doc: "a fleet of lanes each hammering a constant 5s tick is exactly the self-racing load the HARD LAW exists to prevent") — needs explicit tests proving disengagement on recovery, not just engagement on degradation.
- **[Low] Shelling out to the real `multica` CLI in tests would be slow/flaky/require a live daemon.** Mitigation: inject the command-execution function (same pattern as `fetchImpl` injection used throughout the existing Heimdall codebase) so tests never touch a real Multica daemon.
- **[Low] Argus being unreachable (network, remote host down) must not break Heimdall's core health-check function.** Mitigation: OTEL emission failures are fire-and-forget / best-effort, logged but never thrown — matches the existing codebase's "never crash the whole service" philosophy (REQ-07's precedent).

## 5. Dependencies and Constraints

- **New dependency:** `@opentelemetry/*` SDK packages (api, sdk-node, exporter-trace-otlp-grpc or -http). No existing Pantheon precedent to align versions with.
- **External CLI dependency:** the real `multica` binary must be on PATH for `MulticaAutopilotScheduler` to function in production (not required for tests, which inject a mock command runner).
- **No time-sensitive factors.**
- **Depends on the full lane-health-status epic** (already shipped, `feat/lane-health-status` — this branch was created from its tip) — `LanePipeline.refresh()`, `LaneRegistry`, `StateStore` are all consumed as-is.

## 6. Open Questions — RESOLVED (2026-07-25)

1. **RESOLVED.** Multica dispatches a **true agent with its own runtime** — not a trivial "call curl" script. Heimdall's own repo scope is the `MulticaAutopilotScheduler` class that registers the autopilot (`multica autopilot trigger-add`) pointing at a **configured agent identifier** (env var, e.g. `MULTICA_AUTOPILOT_AGENT`) — provisioning the actual Multica-side agent that gets dispatched is a cross-repo/Multica-side concern, out of scope for this epic.
2. **RESOLVED — new scope, not a replacement.** The operator clarified Heimdall's Multica integration has a second, additive purpose beyond triggering `refresh()`: **Heimdall controls Multica's runtime availability** — turning a lane's agent runtime on/off in Multica based on health status. This is exposed as a **third interaction mode**, alongside the two that already exist:
   1. **Agent calls** — already built (MCP tool `heimdall.lanes.list`)
   2. **API calls** — already built (HTTP `GET /lanes` + CLI)
   3. **NEW: action/event stub** — fires on a lane status change, intended to eventually toggle that lane's runtime on/off in Multica. **Build as a stub this epic** (interface + a logged/no-op action, not full Multica-runtime-toggle wiring) — explicitly scoped down by the operator ("one stub for an action/event like system").
3. **RESOLVED (default accepted, no override given):** `InProcessScheduler`'s suspect-lane engagement is poll-based (checks `StateStore` status), not event-driven.
4. **RESOLVED (default accepted):** Backoff on recovery is immediate stop, not gradual.
5. **RESOLVED (default accepted):** Per-lane scheduler configuration lives in env vars, consistent with the existing `HEIMDALL_LANE_<N>_*` pattern.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: Node's built-in test runner (via tsx), same as the rest of the codebase.
  Platforms: local macOS/Linux service process — no new platform surface.
  Automated: Scheduler interface conformance, InProcessScheduler engage/disengage/
    overlap-guard/error-isolation logic (all mockable, no real timers needed if
    injectable clock/timeout), MulticaAutopilotScheduler's command construction
    (mocked child_process, asserting the exact CLI invocation shape — never
    actually shelling out to a real multica daemon in tests), Argus OTEL client
    (mocked exporter, asserting span/metric shape and fire-and-forget failure
    handling).
  Manual: actually registering one real Multica autopilot against a live
    Multica daemon (once Open Question #1 is resolved) and confirming a tick
    really fires; watching one real Argus emission land in Langfuse/SigNoz
    (network-dependent, can't be part of the automated suite).
  Not verifying: Argus's own ingestion correctness (that's Argus's test suite,
    not Heimdall's) — only that Heimdall emits the right shape and degrades
    gracefully if Argus is unreachable.
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~10-14 (Scheduler interface, 2 backend impls, Argus client,
    lane-registry extension for per-lane backend config, DEC doc, tests)
  Subsystems: scheduling (2 backends), observability (new Argus OTEL client),
    external CLI integration (Multica)
  Migration required: no
  Cross-team coordination: no (solo operator), but genuine external-system
    integration novelty (first Argus client in Pantheon)
  Unknowns: 1 major, explicitly raised (Open Question #1 — what Multica
    actually dispatches on autopilot fire)

  RECOMMENDATION: Needs Horizontal + Vertical planning before story decomposition
  RATIONALE: Multi-file, multiple layers (scheduling / observability / external
    CLI), genuinely new external dependency (OTEL SDK) and a real open design
    question that should resolve early rather than be guessed at across many
    stories. Not large enough for a full structured outline — single repo, no
    migration, no compliance surface, and the existing codebase already
    established strong patterns (dependency injection for fetch/child_process,
    ProviderAdapters-style pluggability) this epic reuses rather than inventing.
```
