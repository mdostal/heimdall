# Research Brief — Actuation / CONTROL-Adapter Layer (hdl-actuation)

## Planning input (binding, not a proposal)

`docs/heimdall-role-and-actuation.md` (decision of record `DEC-hdl-role-actuation`, committed by a concurrent session): Heimdall is "sense (v1, done) AND actuate (v2, this epic)." Two adapter kinds:
- **CONTROL** — substrates where agents *persist* (Multica). Heimdall actually enables/disables them on a lane status flip.
- **ADVISORY** — ephemeral consumers (MCP harness, HTTP API). Health-check + calls only, no actuation — **already built** in v1 (`heimdall.lanes.list` MCP tool, `GET /lanes` HTTP).

Build order per the doc: `MulticaControlAdapter` first, then formalize the existing advisory surfaces, then a `StubControlAdapter` placeholder for another Multica-like substrate.

## Independent verification of the doc's claimed Multica REST endpoints (2026-07-25)

The doc cited `~/Documents/work/dostal/code/multica` as its source — **that path does not exist on this machine**. The real, live Multica repo is `/Users/mdostal/Code/multica` (chi v5 Go server under `server/`). Direct source verification found the doc's endpoint claims **partially wrong** in ways that matter for correctness:

| Doc's claim | Verified reality | Why it matters |
|---|---|---|
| `PUT /api/agents/{id}` with `--status` (pause/active) | **WRONG.** `agent.status` CHECK constraint is `idle\|working\|blocked\|error\|offline` (`server/migrations/001_init.up.sql:44`), auto-derived from active tasks. `pause`/`active` belong to the *autopilot* table, not `agent`. Setting `status` to a pause/active value would 500 (invalid DB constant). | Building against this literally would produce a broken actuator. |
| `POST /api/agents/{id}/archive` + `/restore` as the enable/disable mechanism | **RISKY.** `archive` is soft-delete: it **cancels every pending/active task** for the agent (`server/internal/service/task.go` via `CancelAgentTasksByAgent`, confirmed at handler `agent.go:1242-1289`). Not a safe pause — it kills in-flight work every time a lane flips unhealthy. | Using this for routine health-flip gating would be destructive, not a pause. |
| (not claimed, but the actual correct lever) | **`max_concurrent_tasks: 0`** (disable) / `N` (re-enable) via the *same* `PUT /api/agents/{id}` route. Confirmed as the real dispatch gate: `server/internal/service/task.go` — task-claim logic checks `running >= agent.MaxConcurrentTasks` before allowing new task assignment. Setting it to 0 blocks new work without touching anything in flight. | This is the safe, correct, non-destructive actuation primitive `MulticaControlAdapter` must use. |
| `agent_runtime` (status/provider/last_seen_at), workstation/runner lookup | **Confirmed, route corrected.** Real shape includes more fields (`runtime_mode`, `device_info`, `visibility`, etc.) — full response shape in `server/internal/handler/runtime.go:20-39`. **List:** `GET /api/runtimes` (not GET-by-id). **Update:** `PATCH /api/runtimes/{runtimeId}` (not PUT). Runtime `status` enum is `online\|offline` only — a separate, simpler concept from agent status. | Route method/shape corrections needed before implementing the lookup. |
| `POST /api/webhooks/autopilots/{token}` | **Confirmed exactly**, unauthenticated-by-Bearer (token-in-path is the auth), registered outside the authenticated route group. | Not needed for this epic's scope (no webhook-driven actuation planned), but confirms the doc did some things right. |
| Auth mechanism | **Confirmed:** `Authorization: Bearer <token>`. Token sourced from `~/.multica/config.json`'s `token` field (confirmed present, JWT-shaped, file is `0600`) or the `MULTICA_TOKEN` env var (takes priority, `server/cmd/multica/cmd_auth.go:71`). | `MulticaControlAdapter`'s HTTP client needs to resolve this the same way the CLI does. |
| Base URL | **Corrected:** NOT hardcoded `localhost:8080` — that's just this dev machine's self-hosted instance. The config file's `server_url` field is the source of truth; production default is `https://api.multica.ai` (`server/cmd/multica/cmd_setup.go:127`, confirmed in CLI test fixtures). | `MulticaControlAdapter` must resolve `server_url` from config/env, never hardcode a host. |

## Existing codebase to build on

- `src/core/scheduler/actuation-stub.ts` (hdl-04) — `ActuationStub.onStatusChange(lane, from, to)` already fires exactly once per genuine transition. This epic's `MulticaControlAdapter` is what the stub's "would disable/re-enable" log line becomes real.
- `src/core/scheduler/multica-autopilot-scheduler.ts` (hdl-03) — has a working `CommandRunner` injection pattern for the Multica **CLI**. This epic needs its own **HTTP-client injection** pattern instead (mirroring `fetchImpl` injection in `signal-sources/*`), since `MulticaControlAdapter` calls Multica's REST API directly, not the CLI.
- `src/core/lane-registry.ts`'s `Lane` type (`lane_id`, `provider`, `credential_ref`, `credential`) has **no `model` field**. The doc says "a lane = provider + model (e.g. claude/opus-4.8)" — this is a real gap: Heimdall's lane model doesn't currently carry enough information to look up a specific Multica agent by provider+model. **Open question for design discussion, not assumed.**
- 139/139 existing tests passing across `lane-health-status` and `hdl-scheduler` epics — this epic adds new actuation wiring, does not modify `refresh()` or the signal-detection layers.

## Operator corrections/additions (2026-07-25, post-review)

- **Two distinct Multica instances — do not conflate them.** The instance explored during research (this laptop, `~/.multica/config.json`, `server_url: http://localhost:8080`) is a local self-hosted dev instance used only to verify API shapes against real source code — Heimdall never calls it. The instance Heimdall's `MulticaControlAdapter` actually targets is a **separate** instance running on "the hive" (a different board) at **`:8090`** — reachable as `http://localhost:8090` when co-located on the hive, or `http://100.75.161.82:8090` (Tailscale) from elsewhere. Base URL is fully configurable (`MULTICA_BASE_URL`), never hardcoded.
- **Workspace scoping is mandatory**, confirmed independently by the operator against the live hive instance: every `/api/agents` and runtime call needs `workspace_id=d70dc5cf` (this workspace) or `workspace_slug` — a bare call 400s with `{"error":"workspace_id or workspace_slug is required"}`. My own source-verification pass above didn't surface this requirement explicitly; noted here as a correction to apply during implementation.
- **Auth should reuse Heimdall's existing `CredentialSource` abstraction** (the same REQ-07 pattern lane credentials use), not a bespoke token-loading mechanism — consistent with the eventual Portunus migration path.
- **Flaky-connection hardening is a hard requirement**, not a nice-to-have: short timeouts, an explicit "unreachable" result state, no unbounded waits, and a circuit breaker after repeated consecutive failures. The hive connection is known-flaky (WAN).
- **Test strategy locked:** local fake HTTP server only for this epic's development loop — never call the real `:8090` hive instance (an Auriga soak is live against it). Real end-to-end verification against the live hive happens after this epic's code is committed, run by the operator separately.

## Validation confidence

High — verified directly against Multica's actual Go source (migrations, handlers, CLI config code), not just the doc's prose. The doc's core architectural framing (CONTROL vs ADVISORY, build MulticaControlAdapter first) holds up; several of its specific endpoint/field claims needed correction.
