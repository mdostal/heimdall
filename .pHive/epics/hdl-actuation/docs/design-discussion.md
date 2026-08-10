# Design Discussion — Actuation / CONTROL-Adapter Layer (hdl-actuation)

## 1. What Are We Doing?

Heimdall senses lane health (v1, done) but doesn't act on it yet. This epic adds the ACTUATE half: when a lane's status genuinely changes (the exact transition `ActuationStub.onStatusChange` already detects), Heimdall calls Multica's real REST API to disable the agents bound to that lane (stop them claiming new work) when it goes unhealthy, and re-enable them when it recovers. Done means: `MulticaControlAdapter` replaces the stub's "would disable" log line with a real, safe, non-destructive API call — using the actual verified lever (`max_concurrent_tasks: 0`/`N`), not the doc's original (and incorrect) `status`/`archive` proposal. A `StubControlAdapter` placeholder covers "another Multica-like substrate" for later. The existing MCP/HTTP advisory surfaces are untouched — they already do exactly what "advisory" means.

## 2. What I Found

- `docs/heimdall-role-and-actuation.md` (`DEC-hdl-role-actuation`) sets the architectural frame (CONTROL vs ADVISORY, build order) — binding, not re-litigated here.
- **Independent verification against the real Multica source** (`/Users/mdostal/Code/multica`, not the doc's cited-but-nonexistent path) found the doc's specific endpoint claims partially wrong: `status` on `PUT /api/agents/{id}` is an internal derived enum (`idle|working|blocked|error|offline`), not a pause/active toggle — setting it to a pause-shaped value would 500. `archive`/`restore` is soft-delete that **cancels in-flight tasks**, not a safe pause. The actually-correct, non-destructive lever is **`max_concurrent_tasks: 0` / `N`** on the same `PUT /api/agents/{id}` route — confirmed as the real dispatch gate in Multica's task-claim logic. Full corrections: `.pHive/epics/hdl-actuation/docs/research-brief.md`.
- Auth: Bearer token from `~/.multica/config.json`'s `token` field or `MULTICA_TOKEN` env (same resolution the CLI uses). Base URL: `server_url` from that same config, NOT a hardcoded host — production defaults to `https://api.multica.ai`.
- Runtime lookup: `GET /api/runtimes` (list) + `PATCH /api/runtimes/{runtimeId}` (update) — doc had the wrong HTTP method/route shape for the update side.
- **Real gap found:** `src/core/lane-registry.ts`'s `Lane` type has no `model` field. The doc's mental model ("a lane = provider + model") doesn't match Heimdall's actual data model, which is `lane_id/provider/credential_ref/credential` only. Resolving "which Multica agent(s) does this lane correspond to" needs *some* mapping — open question below, not assumed.

## 3. My Proposed Approach

1. **`MulticaRestClient`** (`src/core/actuation/multica-rest-client.ts`) — thin injectable HTTP client (mirrors `fetchImpl` injection already used throughout `signal-sources/*`) resolving base URL (`MULTICA_BASE_URL`, required, no baked-in default) + workspace scoping (`MULTICA_WORKSPACE_ID`, required, appended to every call) + Bearer token via the existing `CredentialSource` abstraction. Exposes `listAgents()`, `updateAgent(id, {max_concurrent_tasks})`, `archiveAgent(id)`/`restoreAgent(id)`, `listRuntimes()`/`patchRuntime(id, patch)`. Every call has a short timeout (AbortController-based) and never throws past a `MulticaCallResult` (`ok | timeout | unreachable | http_error`) — the sense loop must never hang or crash on a flaky hive connection.
2. **`CircuitBreaker`** (`src/core/actuation/circuit-breaker.ts`) — wraps `MulticaRestClient` calls; after N consecutive failures, opens (skips calls, returns `circuit_open` immediately) for a cooldown window, then half-opens to test recovery. Generic, not Multica-specific.
3. **`LaneAgentResolver`** interface + **`StaticLaneAgentResolver`** (`src/core/actuation/lane-agent-resolver.ts`) — resolves `lane_id` → Multica agent ID(s) from `HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS` (comma-separated). A v2 `DiscoveryLaneAgentResolver` (matching provider+model against `GET /api/agents?workspace_id=...`) can implement the same interface later without touching the control adapter.
4. **`ControlAdapter`** interface: `reconcile(lane, status): Promise<void>`, called every sense-loop tick for every lane (not just on transitions) — this is what makes idempotent retry-for-free work.
   - **`StubControlAdapter`** — wraps the existing `ActuationStub` transition-detection (only logs on genuine transitions, loudly) for lanes with no Multica mapping.
   - **`MulticaControlAdapter`** — for mapped lanes: tracks last-successfully-applied `max_concurrent_tasks` per agent; each tick, compares desired state (derived from current lane status) against last-applied, and only calls the API when they differ OR the previous attempt failed (the mismatch simply persists until a call succeeds — no extra "retry" bookkeeping needed). Handles 1:N lane→agent mappings with per-agent partial-failure log-and-continue, plus an Argus metric emission (`emitActuationResult`) on every attempt (success or failure).
5. **Wire into `src/main.ts`** — the shared status-change observer now calls `controlAdapter.reconcile(lane, status)` every tick for every lane, selecting `MulticaControlAdapter` for lanes with an agent mapping and `StubControlAdapter` otherwise.
6. **Do NOT** rename/wrap the existing MCP/HTTP advisory surfaces — confirmed out of scope (Open Question #3).

## 4. What Could Go Wrong

- **[High] Remembering "what to restore to" on recovery.** Setting `max_concurrent_tasks: 0` is easy; restoring the PRE-disable value requires reading and storing it before disabling. If Heimdall restarts between disable and recovery, that memory is lost (in-process state, like the corroboration tracker in `lane-pipeline.ts`). Mitigation: read the agent's current `max_concurrent_tasks` via a GET immediately before the first disable and persist it (in-process is acceptable for v1, matching the existing corroboration-state precedent — restart-loses-state is a known, accepted tradeoff already established in this codebase).
- **[High] Lane→agent mapping is genuinely undefined today.** Building `MulticaControlAdapter` without solving this first would have nothing to actually call. This is Open Question #1 — must resolve before implementation, not guess at.
- **[Medium] Multiple agents per lane.** A lane might map to more than one Multica agent (e.g. multiple runtimes for the same provider/account). The adapter needs to handle a 1:N mapping, disabling/restoring all of them together, and partial-failure handling (2 of 3 succeed) needs a defined behavior (log + continue, don't roll back the successes).
- **[Medium] Live API calls in tests.** `MulticaRestClient` must be fully injectable (mirroring `CommandRunner` from hdl-03) so tests never hit the real Multica server — same pattern, low risk given precedent.
- **[Low] Token/config resolution drift** if `~/.multica/config.json`'s shape changes upstream. Mitigation: resolve defensively, fail clearly (not silently) if the token/URL can't be resolved, matching REQ-07's established error-handling philosophy.

## 5. Dependencies and Constraints

- Depends on `hdl-scheduler` (this branch, `feat/hdl-scheduler` → `feat/hdl-actuation`) for `ActuationStub`'s transition-detection logic, which this epic reuses/extends rather than rebuilding.
- Real external dependency: Multica's REST API must be reachable and the local token valid for `MulticaControlAdapter` to function in production; tests never depend on this.
- No time-sensitive factors.

## 6. Open Questions — RESOLVED (2026-07-25)

1. **RESOLVED: explicit env-var config.** `HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS` (comma-separated, matches the existing lane-declaration convention). Behind a **`LaneAgentResolver`** interface so a v2 auto-discovery resolver (`GET /api/agents?workspace_id=...` matching provider+model) can drop in later without touching the control adapter. Static now, discovery-ready.
2. **RESOLVED: agreed.** Unmapped lane → `StubControlAdapter` (log-only), never a silent no-op. The log must be loud (not a quiet debug line).
3. **RESOLVED: confirmed, no rename.** The existing MCP/HTTP surfaces stay exactly as they are — "advisory adapter" is a descriptive label for what they already do, not a refactor task. Out of scope for this epic.
4. **RESOLVED: log-and-continue, plus two hard additions:**
   - Partial-failure results emit to **Argus as a metric** (a new `ArgusEmitter.emitActuationResult(...)`), not just a console log.
   - Actuation must be **idempotent** — the control adapter reconciles desired-vs-last-applied state on every sense-loop tick (not gated by transition-detection alone), so a failed disable/restore is retried "for free" on the next tick without new machinery.

## Corrected/new facts from the operator (2026-07-25) — supersedes some research-brief assumptions

- **Multica does NOT run on this laptop.** It runs on "the hive" (a separate board) at `:8090`. This is a **different instance** from the locally-authenticated dev Multica I explored during research (which is a self-hosted instance on THIS machine at `:8080`, used only to verify API shapes against real source code — never actually called by Heimdall in this epic).
- **Base URL is mandatory config, never hardcoded, no baked-in default:** `MULTICA_BASE_URL` env var. Prod (co-located on the hive) = `http://localhost:8090`; dev/remote = `http://100.75.161.82:8090` (Tailscale). Heimdall's control loop should eventually run co-located on the hive itself so it isn't driving Multica over the flaky WAN — this epic doesn't set up that deployment, just makes the base URL fully configurable so it works either way.
- **Auth: Bearer PAT via the existing `CredentialSource` abstraction** (REQ-07's pattern, reused directly — not a new credential mechanism) — headed toward Portunus later, same as lane credentials. On the hive, the real token lives at `~/.multica/profiles/dostal/config.json` (a profile-scoped path, distinct from this laptop's unprofiled `~/.multica/config.json`) — Heimdall doesn't read that file directly; it resolves the token the same way lane credentials do, via an env var.
- **Workspace scoping is MANDATORY, not optional:** every `/api/agents` and runtime call needs `workspace_id=d70dc5cf` (or `workspace_slug`) as a query param, or Multica returns `{"error":"workspace_id or workspace_slug is required"}`. `MULTICA_WORKSPACE_ID` env var, required config (no code-baked default — `d70dc5cf` is this specific workspace, not a universal default).
- **Confirmed list endpoint:** `GET /api/agents?workspace_id=...` (list) alongside the already-verified `PUT /api/agents/{id}` (model/max_concurrent_tasks/status/visibility) and archive/restore.
- **Flaky-connection requirements (HARD, non-negotiable):** every Multica call gets a short timeout; a hung or failed hive call must NOT hang or crash Heimdall's sense loop. "Multica unreachable" is its own explicit result state (log + skip actuation that tick, retry next tick) — no unbounded waits. **Circuit-break** after repeated consecutive failures (stop attempting calls for a cooldown window, rather than hammering a down connection every tick).
- **Test strategy locked:** build + test against a **local fake HTTP server** returning the verified Multica response shapes (fast, no DB, zero risk to the live Auriga soak currently running against the real hive instance). Do NOT attempt to reach the real `:8090` hive instance during this epic's development — that's explicitly a follow-up step the operator runs after this epic's code is committed ("fix + test locally against the mock → commit → pull into the hive → real integration test there").

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: Node's built-in test runner (via tsx), same as the rest of the codebase.
  Automated: MulticaRestClient's request construction (mocked fetch, asserting
    exact URL/method/headers/body), token/base-URL resolution from a mocked
    config file, MulticaControlAdapter's disable-then-restore behavior
    (remembers prior max_concurrent_tasks, restores it exactly), multi-agent
    partial-failure handling, StubControlAdapter parity with the existing
    ActuationStub behavior.
  Manual: one real disable/restore cycle against the live Multica instance
    once the lane->agent mapping is configured for a real lane, confirming
    the agent's max_concurrent_tasks actually flips in the real Multica UI/API.
  Not verifying: Multica's own task-claim logic (that's Multica's test suite);
    only that Heimdall calls the right endpoint with the right body and
    degrades gracefully on failure.
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~6-8 (MulticaRestClient, MulticaControlAdapter,
    StubControlAdapter, ControlAdapter interface, lane-registry extension
    for agent mapping, main.ts wiring, tests)
  Subsystems: actuation (new), lane registry (small extension)
  Migration required: no
  Cross-team coordination: no
  Unknowns: 1 major, explicitly raised (lane->agent mapping mechanism)

  RECOMMENDATION: Needs Horizontal + Vertical planning before story decomposition
  RATIONALE: Multi-file, real external API integration with corrected
  (previously wrong) assumptions from the source doc, and a genuine open
  design question (lane->agent mapping) that should resolve before
  implementation stories are written. Not large enough for a full structured
  outline — single repo, no migration, patterns (injectable HTTP client,
  in-process state-with-restart-loses-state) already established by prior
  epics in this same codebase.
```
