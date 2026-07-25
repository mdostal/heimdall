# DEC-hdl-role-actuation

**Status:** Accepted (2026-07-25)
**Cited by:** `docs/heimdall-role-and-actuation.md` ("Decision of record: `DEC-hdl-role-actuation`") — that doc cited this file before it existed; this is the formal record it points to, written after `hda-01` through `hda-04` shipped, so it reflects what was actually built, not just the original plan.

Referenced by (kept in sync, not duplicated): `docs/heimdall-role-and-actuation.md`, `docs/decisions/DEC-hdl-scheduler-backend.md` (sibling decision, same format), `.pHive/epics/hdl-actuation/docs/{research-brief,design-discussion}.md`.

## Decision

Heimdall is the lane **gateway** — sense (v1) **and** actuate (v2) — never a task dispatcher. v2 adds a `ControlAdapter` per lane, called every sense-loop tick from the shared status-watcher in `src/main.ts`:

```
scheduler tick → refresh(lane) → status observed → ControlAdapter.reconcile(lane, status) → substrate
```

Two adapter kinds, not interchangeable:

- **CONTROL** (persistent-agent substrates — agents live in the substrate, not spun up per task): `MulticaControlAdapter` (real, built `hda-01`–`hda-03`) and `StubControlAdapter` (placeholder for a future Multica-like substrate, and the universal fallback below).
- **ADVISORY** (ephemeral consumers that spin up their own agents per task): the existing MCP tool (`heimdall.lanes.list`) and HTTP `GET /lanes`. These needed **no new actuation logic** — they already are the advisory adapter, confirmed out of scope for renaming (Open Question #3 below).

## Corrected Multica API facts (supersede `docs/heimdall-role-and-actuation.md`'s original claims)

Independent verification against Multica's real Go source (not just its docs) during `hda-01` found two of the original design doc's proposed control levers were wrong:

- **`max_concurrent_tasks` is the real, safe actuation lever — not `status` or `archive`/`restore`.** `PUT /api/agents/{id}`'s `status` field is an internal, derived enum (`idle|working|blocked|error|offline`); sending a pause/active-shaped value 500s. `POST /api/agents/{id}/archive` cancels in-flight tasks — destructive, not a safe pause. `MulticaControlAdapter` sets `max_concurrent_tasks: 0` to disable and restores the exact pre-disable value (captured via `listAgents()` before the first disable) to re-enable — never a default guess unless that capture never happened.
- **Workspace scoping is mandatory, not optional.** Every `/api/agents` and `/api/runtimes` call requires `workspace_id` (or `workspace_slug`) as a query param, or Multica 400s with `{"error":"workspace_id or workspace_slug is required"}`. `MulticaRestClient` appends it to every request automatically from `MULTICA_WORKSPACE_ID` (required config, no baked-in default — that ID is deployment-specific).
- **Two distinct Multica instances exist and must never be conflated.** (a) A local, self-hosted dev instance on this laptop at `:8080` — used only to read/verify real Go source and CLI behavior during research; Heimdall never calls it. (b) The real target: a separate instance on "the hive" (Heimdall's own deployment board) at `:8090` — co-located prod is `http://localhost:8090`, remote/dev over Tailscale is `http://100.75.161.82:8090`. `MULTICA_BASE_URL` is required config with no code-baked default, since either value would be actively wrong depending on where Heimdall runs.
- **Auth is a Bearer PAT resolved via the existing `CredentialSource` abstraction** (`EnvCredentialSource`, REQ-07's pattern) — reused directly, not reinvented, same as lane credentials. Default `credential_ref`: `MULTICA_PAT_TOKEN`.

## Flaky-connection hardening

The hive's connection is known-flaky (operator's network). `MulticaRestClient` (`hda-01`) never throws — every call resolves to a `MulticaCallResult` (`ok | timeout | unreachable | http_error`), using an `AbortController`-based timeout (default 3000ms). `MulticaControlAdapter` wraps every call through a generic `CircuitBreaker` (`hda-01`, closed/open/half-open, default 3-failure threshold / 30s cooldown) so a sustained outage stops hammering Multica and fails fast instead. Neither component ever crashes or hangs Heimdall's sense loop — a Multica outage degrades actuation, not health sensing.

## Four resolved open questions (`hda-02`/`hda-03` design discussion, 2026-07-25)

1. **Lane → Multica agent mapping: explicit env-var config, not auto-discovery.** `HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS` (comma-separated), read by `loadStaticLaneAgentMappings()`/`StaticLaneAgentResolver`, behind a `LaneAgentResolver` interface so a v2 auto-discovery resolver (matching provider+model against `GET /api/agents?workspace_id=...`) can drop in later without touching `MulticaControlAdapter`. Static now, discovery-ready by design.
2. **Unmapped lanes get `StubControlAdapter` — never a silent no-op.** Confirmed in `hda-04`'s wiring: every lane always has *some* `ControlAdapter` assigned. `StubControlAdapter` logs loudly via `console.warn` (not `console.log`) on every genuine status transition it observes, by explicit operator instruction — an unmapped lane's actuation gap must be visible in normal operation, not buried in debug output. The same fallback applies at the whole-service level: if `MULTICA_BASE_URL`/`MULTICA_WORKSPACE_ID`/the PAT token aren't configured at all, `MulticaRestClient` construction throws, `composeService()` catches it, warns once, and every lane falls back to `StubControlAdapter` — the service still starts and senses lane health normally.
3. **No renaming or wrapping of the existing MCP/HTTP advisory surfaces.** `heimdall.lanes.list` (MCP) and `GET /lanes` (HTTP) already are the advisory adapter, by construction — "advisory adapter" is a descriptive label for what they already do, not a refactor task. Confirmed out of scope for `hdl-actuation`; incremental routers on top are a future, unscoped concern ("add the routers as we go").
4. **Partial failure: log-and-continue, plus idempotent retry-for-free and Argus metrics.** A 1:N lane→agent mapping's per-agent failures are logged and do not roll back agents that already succeeded (Multica's REST API has no cross-call transaction, and rolling back a disable would re-enable into a still-unhealthy lane). `MulticaControlAdapter.reconcile()` runs every tick for every lane (not gated by transition-detection), comparing desired state against the last-successfully-applied state per agent; a mismatch — whether from a genuine status change or a previous failed attempt — triggers exactly one retry, with zero bespoke retry bookkeeping. Every attempt, success or failure, emits an Argus span via `ArgusEmitter.emitActuationResult()` (`{laneId, provider, agentId, action, success, reason}`).

## What's still deferred

- A v2 `DiscoveryLaneAgentResolver` (auto-mapping lanes to agents by provider/model via `GET /api/agents`) — the static env-var resolver is intentionally interface-scoped to allow this later without touching `MulticaControlAdapter`.
- A second real `ControlAdapter` for another Multica-like persistent-agent substrate — `StubControlAdapter` is the placeholder until one exists.
- Incremental advisory-side routers on top of the existing MCP/HTTP surfaces (explicitly out of scope here).
- Gradual backoff/half-open tuning for the `CircuitBreaker` beyond the current fixed threshold/cooldown.

## Verification is an operator follow-up, not part of this epic

Every test across `hda-01`–`hda-04` runs against local fakes/mocks only (`MulticaRestClient`'s `fetchImpl` injection, in-memory `MulticaCallResult` stand-ins) — **none of this epic's test suite calls the real hive Multica instance at `:8090`**, by design, since a live Auriga soak is running against that same instance and must not be disturbed. Real end-to-end verification — confirming `MulticaControlAdapter` actually disables/re-enables a live Multica agent through the real REST API on the hive — is an explicit **operator follow-up step**, performed manually after this epic's code is committed, not automated as part of `hdl-actuation`.

## Consequences

- Any future actuation substrate (a second persistent-agent system, or a discovery-based lane→agent resolver) must implement the existing `ControlAdapter`/`LaneAgentResolver` interfaces rather than growing new ad hoc wiring in `src/main.ts`.
- `composeService()`'s Multica actuation stack (client + circuit breaker + resolver) is built once per service and shared across all lanes' `MulticaControlAdapter` instance — per-agent state (`lastAppliedEnabled`, `priorMaxConcurrentTasks`) lives in-process and is lost on restart, the same accepted tradeoff already established for `LanePipeline`'s corroboration state.
