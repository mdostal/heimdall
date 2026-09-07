# Research Brief — hdl-multica-status-handoff

## 1. Trigger

`heimdall#83` (filed 2026-08-27 from pantheon-v2's dogfood-loop epic, PR #87):
`MulticaControlAdapter.disableAgent()` calls `restClient.updateAgent(agentId, {
max_concurrent_tasks: 0 })`. Confirmed live against a real, self-hosted Multica
instance (`dostal@hive`): the call 400s with
`{"error":"max_concurrent_tasks must be between 1 and 50"}`. The documented
disable lever has never been valid on this backend.

## 2. Operator direction (this session)

Presented four fix options for the lever itself (throttle-to-floor,
archive-based, severity-tiered hybrid, pluggable policy) via Artifact. Operator
response, verbatim: *"first, your job is to turn off the lever not to fix it --
so it seems you need to give back the status and such and we build the lever
change on the pantheon so IT integrates into multica correctly"*.

This rejects all four presented options in favor of a fifth: Heimdall stops
actuating Multica directly at all. It becomes a pure status/mapping source;
the actual lever-flipping (with whatever throttle/archive semantics Multica's
real constraints demand) is built on the Pantheon side, which already owns the
real Multica PAT and a facade at this exact contract shape (pantheon-v2 PR #87,
merged, `core/api/runners.ts`). This epic's job is the Heimdall-side half only:
retire the broken lever, make sure everything Pantheon needs to actuate
correctly is actually exposed.

## 3. What Multica's real source confirms (read live, `dostal@hive:/Users/hive/Code/spikes/multica`, server package, dev checkout — grounds the "why" for retiring rather than patching)

- `server/internal/agentconfig/concurrency.go`: `MinMaxConcurrentTasks = 1`,
  `MaxMaxConcurrentTasks = 50`, hard-validated, no exception path. Zero was
  never legal.
- `server/internal/service/task.go`, `TaskService.ClaimTask`: the *only* gate
  a claim passes through is `running >= agent.MaxConcurrentTasks`. There is no
  separate idle/disabled/paused check — an agent at `max_concurrent_tasks: 1`
  still claims the next queued task the moment it's idle. Concurrency is a
  throttle, not a switch, at any value ≥ 1.
- `server/internal/handler/agent.go`, `Handler.ArchiveAgent`: the only call
  that actually removes an agent from claim eligibility also unconditionally
  cancels every pending/running task for it (`CancelAgentTasksByAgent`) in the
  same request. True stop, but destructive to in-flight work every time.
- `status` on `PUT /api/agents/{id}` is accepted syntactically but is
  server-derived (`TaskService.ReconcileAgentStatus` overwrites it from live
  task state on the next event) — confirms Heimdall's own existing header
  comment in `multica-rest-client.ts` was already correct that this isn't a
  manual toggle.
- No third lever exists anywhere in the source (grepped for
  `paused`/`is_enabled`/`accepting_tasks`/`dispatch_enabled` across the whole
  server package — the only hits are for an unrelated autopilot-run pause
  concept, not agent dispatch eligibility).

**Conclusion this brief draws from the above:** there is no way, today, for
any caller of Multica's real REST API to say "stop routing new work to this
agent, but don't touch what's already running." Multica itself has the gap,
not just Heimdall's assumption about it. That's a fact for the design
discussion to state plainly — it's the reason "fix the number" was never a
real option, independent of the operator's architectural redirect.

## 4. Heimdall's current actuation stack (fully isolated, confirmed via repo-wide grep)

`src/core/actuation/{multica-rest-client,multica-control-adapter,circuit-breaker,lane-agent-resolver}.ts`
are used *only* by each other and by their construction/wiring in
`src/main.ts` (lines ~103-212, `buildMulticaActuationStack` +
`sharedMulticaControlAdapter` + the per-lane `controlAdapter` selection).
Nothing else in the codebase imports them functionally — every other match is
a comment referencing the concept for context (`route-selector.ts`,
`round-robin-strategy.ts`, `in-process-scheduler.ts`, `http-server.ts:1209`,
`argus-client.ts`, `adapters/argus.ts`). This means retiring the stack is a
clean, bounded cut — no hidden coupling elsewhere.

**Not in scope, confirmed separate:** `MulticaAutopilotScheduler`
(`src/core/scheduler/multica-autopilot-scheduler.ts`) shells out to the
`multica` CLI directly for a completely different purpose (registering
autopilot cron triggers) and shares no code with the actuation stack above.
Leave it untouched.

## 5. What "give back the status" already has vs. still needs

`GET /lanes` (`src/api/http-server.ts:711`, backed by `getLaneStatuses()` at
line 536) already returns, per lane: `status`, `reason`, `reset_at`,
`manual_override`, `override_reason`, `manual_reset_at`, `manual_headroom`,
`manual_cost_tier`, `credential_configured`, `model`, `credential_ref`,
`priority`. This is real, live, already-shipped status-reporting — most of
"give back the status" is a solved problem today.

**The one real gap:** the lane→Multica-agent-ID mapping
(`HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS`, resolved internally by
`StaticLaneAgentResolver` in `lane-agent-resolver.ts`) is known to Heimdall
but never leaves the process — it's read only by `MulticaControlAdapter`
itself. If Heimdall stops actuating, Pantheon's own facade needs this mapping
to know *which* Multica agent(s) a given lane's status corresponds to. Without
exposing it, Pantheon would have to duplicate the mapping as its own config,
which drifts from Heimdall's the moment either side changes independently.

## 6. Out of scope for this epic (belongs in pantheon-v2, a different repo/task_tracking.repo)

Building the actual correct lever logic (severity-tiered or otherwise) against
the real Multica constraints from §3 is explicitly the operator's stated
next step *on the Pantheon side*. This epic's `task_tracking.repo` is
`heimdall`; per this skill's own step 0a repo-match gate, planning that work
here would be the wrong-repo failure mode already seen once with
`sandcastle-gh-issue-dispatch`. Recommend it as a clear follow-up epic to run
from the `pantheon-v2` checkout, referencing this epic's §3 findings and the
new mapping surface from §5 — not built here.
