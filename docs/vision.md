# Heimdall — Vision

Heimdall is the **health-aware lane gateway and router** for [Pantheon](https://github.com/mdostal/pantheon-v2).
This document is the trajectory: where it is now, what's next, and where it grows
to. Contributors can pick a rung and jump in.

A lane is a `provider × account × runtime` triple — `claude@mathew.dostal`,
`claude@dostalmathew`, `codex`, `gemini-3-pro`, `openrouter/grok`, `ollama-local`
— each with its own long-lived credentials. Heimdall's job is to know which lanes
are healthy and to act on that knowledge.

---

## ① Current — where it is (v0.33.0)

Heimdall runs as a headless Node/TypeScript service on **`http://localhost:4870`**
(override with `PORT`). Everything below actually runs today.

**Sensing — 6/6 north-star providers.** Layered signal sources (`passive`,
`public_status`, `active_probe`) resolve every lane to `up`, `down`,
`out_of_credit`, or `degraded` via `resolveStatus()`, a pure function that never
throws on malformed input. A corroboration policy guards against provider
false-positives. Adapters exist for **Claude** (both raw API keys and Claude Code
subscription OAuth tokens — the latter shells out to the real `claude` CLI, the
only active-probe in the codebase that spends real inference, since there's no
free way to validate that credential type), **Codex**, **Gemini**, **Kimi K3**,
**OpenRouter** (nests as a gateway with independently-toggleable routes under one
credential, not a flat lane), and **Ollama** (liveness-only — no auth, no
degraded/out_of_credit concept for local inference). State persists to a
**`node:sqlite`** store (`HEIMDALL_DB_PATH`, default `~/.local/share/heimdall/heimdall.db`
via `resolveDefaultDbPath()` — a real per-machine persistent file, not
in-memory, so the dashboard server, an MCP process, and the CLI can all open
the same DB at once). SLA-verified:
status correctness within 10 seconds of an actual state change, *measured* by
`test/sla-harness/`.

**Full error codes, not just a status.** Every lane carries a normalized
`ErrorCode` (`rate_limit | quota_exceeded | billing_error | auth_failed |
server_error | network_error | unknown`) *alongside* the free-text native
`reason` — never one instead of the other. `GET /lanes` and the dashboard
surface both. This isn't just richer display: `InProcessScheduler` uses the
code to take real scheduling action — `auth_failed` lanes back off to a fixed
5-minute recheck instead of the fine ~5s cadence, since an auth failure has
no self-healing event to miss (only an operator fixing the credential helps);
every other error class keeps the SLA-driven cadence unchanged.

**Model catalog.** Each installation fetches its own live model list per
configured provider and stores a local enable/disable per model — newest
generation on by default, older generations available but off, never shipped in
git (an OSS install has its own real provider access). `GET /available-route`
and `POST /route` both substitute automatically when a declared model is
disabled or has vanished from the live catalog.

**Scheduling.** Pluggable per-lane `Scheduler`: `MulticaAutopilotScheduler`
(default, coarse cron registered as a **Multica autopilot** — honoring the "no
local box runners" rule) and `InProcessScheduler` (fine ~5s, suspect-lanes only,
backs off immediately on recovery, reset_at-aware when a real recovery time is
known). The flat ~5s cadence for suspect lanes with an *unknown* reset_at is
**load-bearing for the 10-second SLA**, not an arbitrary default — the SLA
harness's own finding is that a scheduler ticking slower than ~5s risks missing
the 2-tick corroboration window. Backing this off further trades away a shipped,
tested guarantee and isn't a routine tuning pass (see "Goals" below).

**Actuation.** `MulticaControlAdapter` calls Multica's real REST API to
disable/re-enable a lane's mapped agents (`max_concurrent_tasks` 0/N) through a
circuit-breaker-hardened `MulticaRestClient`. Every lane always gets a
`ControlAdapter` — mapped lanes get the real one, everything else falls back to
a loud `StubControlAdapter`, never a silent no-op.

**Routing — pluggable, scored, and closed-loop.** Route selection sits behind a
`RoutingStrategy` interface: `priority` (default), `round-robin`, `scored`
(weighted candidate scoring against `config/routing-policy.yaml`, deterministic
A/B experiment arms, generated rationale, a decision ledger), and `off`. Manual
lane override gates candidacy the same way actuation does. A caller that gets a
`decision_id` from `POST /route` can report back what actually happened via
`POST /route/:decisionId/outcome` — the ledger now records outcomes, not just
decisions.

**Multi-account rotation.** `RotationController` is wired into the live service
for any provider with 2+ credentialed lanes — detects Claude-specific cap
signals, marks the account capped, and can rotate to the next healthy one,
manually or via `GET`/`POST /rotation/:provider[/rotate]`. Not wired into the
live completion-call path itself (deliberately — see "Long-term vision", the
"avoid a full gateway" boundary).

**Heimdall's own telemetry.** `GET /metrics` (Prometheus text format) and a
dashboard Telemetry panel, aggregated entirely from local state — actuation
results, rotation events, model substitutions, routing decisions, lane counts.
Argus (or anything else OTEL/Prometheus-compatible) is a downstream consumer,
composed alongside the local recorder, never Heimdall's only source of truth.

**UI.** A self-contained dashboard (no build step, no framework) — live lane
status, per-lane override/reset-at controls, add-lane form, routing-strategy
picker, model-catalog toggles, a read-only routing-policy panel (per-task-
type weights, headroom floor, cost preference, experiment status — the same
`config/routing-policy.yaml` the scored strategy reads, made visible without
reading YAML), and the telemetry panel. `GET /docs` and `GET /docs/:slug`
render the project's own markdown docs in-app, with Mermaid diagrams
rendered client-side against a locally-vendored bundle — no CDN, no network
call, docs and diagrams browsable from the running service itself.

**Standalone desktop app.** A real, installable macOS app (Tauri v2,
`app/`) — a genuine single point of install, not just the headless service.
A Rust shell spawns Heimdall's own compiled service as a sidecar (captures
the real login-shell PATH, binds a free port, wires a stable per-user
app-data directory for the SQLite DB and `.env`), health-checks it before
showing the dashboard, and provides a tray icon with close-to-tray behavior
and gh-CLI-backed self-update. Ad-hoc signed, single-machine target — no
Apple Developer Program distribution. Live-verified end to end, including
the actual release `.app` bundle installed and run standalone, not just the
dev-mode wrapper.

**Pantheon integration.** Heimdall's real L2 descriptor (capabilities,
`healthz`, port, transport) is registered in `pantheon-v2`.

**Installable CLI and agent onboarding.** Heimdall ships as a real global npm
package (`npm install -g pantheon-heimdall`, or the one-liner `curl -fsSL
https://mdostal.github.io/heimdall/install.sh | bash`), not just a repo
checkout. The `heimdall` bin (`bin/heimdall.js`) is a cross-platform shim that
dispatches to the compiled CLI — `heimdall lanes`/`route`/`route-outcome` for
one-shot calls, and `heimdall mcp` to speak the MCP protocol over stdio.
`heimdall agent init` is the onboarding command: it detects which coding
harnesses (`claude`, `codex`) are actually installed on the machine,
idempotently registers Heimdall as an MCP server with each one (`heimdall
agent status` reports current registration state without changing anything),
and installs the four real usage skills (`heimdall-lanes`, `heimdall-routing`,
`heimdall-models`, `heimdall-status`) into the harness's skills directory —
turning "clone the repo and read the source" into "install, run one command,
start asking your agent about lane health." `scripts/install.sh` wraps the
same two steps (global install + `agent init`) with Node-version and PATH
error handling for the curl-to-bash path.

**Honest gaps.**
- Actuation is tested **entirely against local mocks** in this repo's own test
  suite. Live end-to-end verification against the real hive Multica instance is
  no longer a dedicated to-do here — Pantheon's own deployment pipeline now
  exercises this live as it ships things out.
- Credentials come from **local env vars** (`.env`), a deliberate stopgap ahead
  of Portunus.
- Pantheon **plugin mode** (config through Vesta/Multica instead of local
  `.env`) is blocked on Pantheon Core shipping a real cross-god request/
  response mechanism — today only fire-and-forget notification events exist.
  See `docs/decisions/DEC-hdl-portunus-deferral.md`.

---

## ② Goals — near-term next steps

- **Probe-cadence tuning, done carefully.** The naive version of "probe suspect
  lanes harder, healthy lanes rarely" already happened (healthy lanes never pay
  the fine-grained refresh cost at all; known reset_at is honored directly).
  What's left — backing off further on lanes stuck `down`/`degraded` with no
  known reset_at — trades against the documented 10-second SLA and needs an
  explicit operator call on which guarantee to weaken, not a routine pass.
- **Headroom/cost-tier defaults.** `HEIMDALL_LANE_N_HEADROOM`/`_COST_TIER` exist
  and feed the scored strategy, but most operators will never set them —
  consider whether a cheap, automatic headroom signal (e.g. inferred from
  recent `out_of_credit` frequency) beats the current static default. Needs an
  operator call on the actual inference approach, not a routine pass.

---

## ③ Long-term vision

Heimdall grows from a health **gateway** into a full **health-aware router**: the
component Auriga calls on every dispatch — input `{task-type, est-cost,
constraints}`, output `{chosen lane + creds handle}`, with the loop closed by
outcome feedback.

- **Full multi-lane token routing.** Every runner is used, routed by *live
  health* and headroom — premium/architecture work to Claude/Fable, bulk/grunt to
  cheaper lanes, images to the right image model, and never real feature work to a
  distrusted cheap tier. On rate-limit, **swap lanes, don't halt; recover, don't
  recreate.**
- **Rotation stays credential-selection, not call-wrapping.** The north star's
  own `avoid` clause rules out Heimdall becoming a full LLM proxy — rotation
  answers "which account," not "make this call for me." That boundary is
  deliberate, not a gap to close.
- **An SLA harness as a first-class product surface,** not just a test:
  continuously proving that routing decisions honor per-lane correctness and
  latency guarantees.
- **Per-account long-lived tokens via Portunus** — the prerequisite that makes
  cross-account sharing real. Minting and storing them harness-side is blocking
  for cross-account routing and is tracked as a dependency, not owned here.
- **Two distribution modes, always.** Like every Pantheon god, Heimdall is
  open-source and ships **standalone** — now a real installable desktop app
  (`app/`), carrying its own dashboard/docs UI, usable from any harness that
  can spin up multiple agents — *and* as a **Pantheon plugin** (config through
  Vesta/Multica). Same core, two front doors — the descriptor is registered
  and the standalone side is real and dogfoodable; secret resolution through
  Portunus (needed for the plugin side's credential story) is what's still
  blocked.

Platform-wide, this rides Pantheon's core principle: **everything is swappable.**
Any language, model, plugin, or god can be toggled on/off and compared on metrics
at every step — Heimdall is exactly the god that makes "compare lanes on live
health and cost, then route" a first-class, measurable operation.

---

## Good first contributions

- **Widen the CLI `--format table`** output or add a `--watch` mode over the
  existing `getLaneStatuses()` core.
- **Extend the SLA harness** (`test/sla-harness/`) with new state-transition
  scenarios.
- **Document a real Multica actuation runbook** from `.env.example` — the safe
  operator path to a live end-to-end toggle.
- **Make the routing-policy panel editable**, not just read-only — the current
  panel (`GET /routing-policy`) is a deliberate read-only-first scope; a
  `POST` that writes back to `config/routing-policy.yaml` (with the same
  validation `PolicyLoader` already does) would close the loop.
- **Harden `resolveStatus()`** against additional malformed-signal shapes with
  new table-driven tests in `src/core/status-model.test.ts`.

New to the codebase? Start at `src/main.ts` (`composeService()`) — it wires every
piece together and is the fastest map of how sensing, scheduling, routing, and
actuation compose into the running service.
