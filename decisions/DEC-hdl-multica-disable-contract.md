# DEC-hdl-multica-disable-contract

**Status:** Accepted (2026-08-27)
**Supersedes (partially):** [`DEC-hdl-role-actuation.md`](DEC-hdl-role-actuation.md) — that decision's "Heimdall is the lane gateway — sense **and** actuate" framing and its `MulticaControlAdapter`/`max_concurrent_tasks: 0` disable lever are retired by this decision. Its other content (the `ControlAdapter`/`StubControlAdapter` split, unmapped-lane logging, flaky-connection hardening as a pattern) is unaffected and still accurate.
**Trigger:** [`heimdall#83`](https://github.com/mdostal/heimdall/issues/83) — `MulticaControlAdapter.disableAgent()`'s documented lever (`max_concurrent_tasks: 0`) is rejected by Multica's real API.

## Decision

Heimdall no longer actuates Multica directly. It senses lane health and
reports it (`GET /lanes`, MCP tools, HTTP/CLI) — the same role it has always
had — but the `ControlAdapter`/ `MulticaControlAdapter` half of
`DEC-hdl-role-actuation` is retired, not fixed. Every lane's control adapter
is now unconditionally `StubControlAdapter`. `GET /lanes` gains
`multica_agent_ids: string[]` per lane so a downstream actuator — Pantheon's
own facade, `pantheon-v2`'s `core/api/runners.ts` (already shipped, PR #87)
— can correlate a lane's status to a real Multica agent and build the
correct lever on its own side.

This is not a fallback for "actuation isn't configured yet." It's permanent:
Multica's real API has no lever that can implement "stop routing new work to
this agent, don't touch what's already running," so there was never a
working version of this feature to restore.

## What's actually true about Multica's API (verified live + against real source, not assumed)

Read directly from Multica's own server source
(`dostal@hive:/Users/hive/Code/spikes/multica`, `server` package) and
confirmed against a live 400 from the real instance:

- **Concurrency has a hard floor of 1, not 0.**
  `server/internal/agentconfig/concurrency.go`: `MinMaxConcurrentTasks = 1`,
  `MaxMaxConcurrentTasks = 50`, validated with no exception path. A `PUT
  /api/agents/{id}` with `max_concurrent_tasks: 0` 400s:
  `{"error":"max_concurrent_tasks must be between 1 and 50"}`. This is what
  `heimdall#83` reported.
- **Concurrency is a throttle, not a switch, at any legal value.**
  `server/internal/service/task.go`, `TaskService.ClaimTask`: the only gate
  a task claim passes through is `running >= agent.MaxConcurrentTasks`. An
  agent at `max_concurrent_tasks: 1` that's currently idle still claims the
  next queued task. There's no separate idle/disabled distinction below
  that check — sending `1` "disables" nothing, it only caps burst.
- **The only real stop is destructive.** `server/internal/handler/agent.go`,
  `Handler.ArchiveAgent`: removes an agent from claim eligibility, but
  unconditionally cancels every pending/running task for it
  (`CancelAgentTasksByAgent`) in the same request. A genuine stop, at the
  cost of every in-flight task on that agent, every time — including a
  transient status blip.
- **`status` on the update endpoint isn't a manual toggle.** Accepted
  syntactically, but server-derived — `TaskService.ReconcileAgentStatus`
  overwrites it from live task state on the next event. Confirms
  `DEC-hdl-role-actuation`'s original finding on this point was already
  correct.
- **No fourth lever exists.** Grepped the whole server package for
  `paused`/`is_enabled`/`accepting_tasks`/`dispatch_enabled` — the only
  hits are an unrelated autopilot-run pause concept, not agent dispatch
  eligibility.

**Conclusion:** there is no way, today, for any caller of Multica's real
REST API to say "stop routing new work to this agent, but don't touch what's
already running." This is a real gap in Multica itself, not a wrong
assumption on Heimdall's side about how to call an existing lever.

## Why retire rather than patch

Four ways to patch the lever's number were scoped and presented (throttle to
the floor of 1, use archive/restore as the real lever, a severity-tiered
hybrid of the two, a pluggable per-deployment policy — full comparison in
the Artifact linked below). The operator's direction:

> "your job is to turn off the lever not to fix it -- so it seems you need
> to give back the status and such and we build the lever change on the
> pantheon so IT integrates into multica correctly"

Heimdall's job becomes: report status accurately and completely (already
mostly true — `GET /lanes` already returned status/reason/reset_at/manual
overrides/headroom/cost-tier before this decision; the one gap was the
lane→agent mapping, closed by this epic). Building the actual disable
semantics against Multica's real constraints belongs on the Pantheon side,
which already owns the real Multica PAT and a facade at this exact contract
shape.

This decision deliberately does **not** prescribe which of the four options
Pantheon should build — that's a real architecture decision for whoever
plans that (separate) epic, with full context, not something to pre-decide
from a document written before that planning happens. The four options
considered here, with their real tradeoffs, are preserved for reference:
**https://claude.ai/code/artifact/dbe7d4f4-3f08-4021-b2e2-00c0d1a26778**
("Multica Disable Lever").

## What changed in this repo

- Deleted (fully isolated, confirmed via repo-wide grep before removal):
  `src/core/actuation/multica-rest-client.ts`,
  `src/core/actuation/multica-control-adapter.ts`,
  `src/core/actuation/circuit-breaker.ts`, and their tests.
- `src/main.ts`: every lane's `ControlAdapter` is unconditionally
  `StubControlAdapter` — the same fallback path every unconfigured
  deployment already used; this makes it the only path.
- `src/api/http-server.ts`: `getLaneStatuses()` gains
  `multica_agent_ids: string[]` per lane (`[]` when unmapped, never
  omitted), sourced from `LaneAgentResolver`/`StaticLaneAgentResolver`
  (`HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS`) — kept, repurposed from feeding
  the deleted adapter to feeding this field instead.
- `MulticaAutopilotScheduler` and `MULTICA_AUTOPILOT_AGENT` are unaffected —
  a separate feature (registers autopilot cron triggers via the `multica`
  CLI) confirmed to share no code with the retired actuation stack.
- `ControlAdapter`, `StubControlAdapter`, and `ActuationStub` are unchanged
  — they already correctly modeled "no real action taken," and already
  phrase their logging as hypothetical ("would disable/re-enable..."),
  which turns out to already be accurate for this new, permanent state.

## What a currently-configured deployment sees

Nothing observably regresses. Every disable attempt has 400'd since the
`hda-03` epic shipped this lever — `heimdall#83` itself is the proof it
never worked. `MULTICA_BASE_URL`/`MULTICA_WORKSPACE_ID`/`MULTICA_PAT_TOKEN`
become inert if still set in an operator's real `.env` (nothing constructs a
`MulticaRestClient` anymore); no migration or unset is required for the
service to keep working correctly.
