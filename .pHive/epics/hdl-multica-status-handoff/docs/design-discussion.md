# Design Discussion — hdl-multica-status-handoff

## 1. What Are We Doing?

`heimdall#83`: `MulticaControlAdapter.disableAgent()` calls
`updateAgent(id, { max_concurrent_tasks: 0 })`, and Multica's real API
rejects 0 (confirmed live against `dostal@hive` — 400,
`max_concurrent_tasks must be between 1 and 50`). An Artifact presented four
ways to patch the lever itself. The operator rejected patching it: *"your job
is to turn off the lever not to fix it — so it seems you need to give back
the status and such and we build the lever change on the pantheon so IT
integrates into multica correctly."*

So this epic does two things, both entirely inside Heimdall's own repo:

1. **Retire** Heimdall's direct Multica actuation (`MulticaControlAdapter`,
   `MulticaRestClient`, the actuation `CircuitBreaker`) — Heimdall stops
   calling Multica's REST API to flip agents on/off, permanently, not
   behind a flag.
2. **Complete** Heimdall's status-reporting surface so Pantheon's own facade
   (`pantheon-v2`'s `core/api/runners.ts`, already shipped, PR #87) has
   everything it needs to build the real lever itself — which turns out to
   be one missing field, not a new subsystem.

"Done" looks like: heimdall#83 closes because the broken code path no longer
exists, not because it was patched to a still-imperfect number. `GET /lanes`
tells Pantheon which Multica agent(s) a given lane's status maps to, so
Pantheon can decide the real disable semantics on its own side, informed by
constraints this epic's research already verified in Multica's own source
(see research-brief.md §3) but does not act on here.

## 2. What I Found

- The actuation stack is fully isolated: `src/core/actuation/{multica-rest-
  client,multica-control-adapter,circuit-breaker}.ts` are used only by each
  other and by their construction in `src/main.ts` (`buildMulticaActuation
  Stack`, `sharedMulticaControlAdapter`, the per-lane `controlAdapter`
  selection at lines ~141-206). Every other repo-wide match is a comment
  referencing the concept, not a functional import. Deleting them is a clean
  cut, not a refactor.
- `main.ts` already has a fully-proven "no real actuation" path: any
  deployment missing `MULTICA_BASE_URL`/`WORKSPACE_ID`/PAT already falls back
  to `StubControlAdapter` for every lane today (`buildMulticaActuationStack`
  catches the constructor throw and returns `null`). This epic doesn't invent
  a new "off" state — it makes the existing, already-tested off state the
  *only* state, unconditionally.
- `LaneAgentResolver`/`StaticLaneAgentResolver` (`lane-agent-resolver.ts`) is
  presently used *only* to feed `MulticaControlAdapter` the agent-ID mapping.
  It doesn't need to be deleted — it needs a new consumer. The resolver
  itself (env-var-parsed `HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS`) is exactly the
  data Pantheon needs and doesn't have today.
- `GET /lanes` (`getLaneStatuses()`, `http-server.ts:536`) already returns
  everything else: `status`, `reason`, `reset_at`, `manual_override`,
  `override_reason`, `manual_reset_at`, `manual_headroom`,
  `manual_cost_tier`, `credential_configured`, `model`, `priority`. "Give
  back the status" is ~95% already shipped; the gap is narrowly the
  lane→agent-ID mapping, not a new reporting mechanism.
- `MulticaAutopilotScheduler` (`multica-autopilot-scheduler.ts`) is a
  separate feature (registers autopilot cron triggers via the `multica` CLI)
  that shares no code with the actuation stack — confirmed via source read,
  not assumption. It is explicitly untouched by this epic; its env var
  (`MULTICA_AUTOPILOT_AGENT`) is unrelated to the ones this epic removes.
- `.env.example` currently documents `MULTICA_BASE_URL`, `MULTICA_
  WORKSPACE_ID`, and `MULTICA_PAT_TOKEN` as actuation config. Once the REST
  client that reads them is deleted, they become dead documentation —
  actively misleading if left in place (an operator would configure
  credentials Heimdall no longer uses for anything).
- The operator's own `.env` on this machine currently has these three vars
  set (confirmed in an earlier session this window). They become inert, not
  broken — `composeService()` simply never constructs anything that reads
  them anymore. No migration needed, nothing to unset for the service to
  keep working; only doc hygiene.

## 3. My Proposed Approach

**Retirement (closes heimdall#83):**
- Delete `src/core/actuation/{multica-rest-client,multica-control-
  adapter,circuit-breaker}.ts` and their `.test.ts` files.
- **Also edit `src/main.test.ts`** (grill H1 — verified directly, not
  assumed): it currently contains a test at line 376 asserting a mapped lane
  gets a real `MulticaControlAdapter` when Multica is configured, plus a
  test around line 416 that constructs and exercises one through
  `composeService()`. Both reference a class that no longer exists after
  this change and will fail to compile, not just fail assertions — rewrite
  the line-376 test to assert `StubControlAdapter` unconditionally
  regardless of `MULTICA_*` env config, and remove or rewrite the ~line-416
  test since there's no real adapter left to exercise. This happens in the
  same story as the `main.ts` wiring change — they fail or pass together.
- In `main.ts`: delete `buildMulticaActuationStack()` and
  `sharedMulticaControlAdapter`; the per-lane loop always assigns
  `sharedStubControlAdapter` to `controlAdapters`. The `statusWatcher`
  interval and `ControlAdapter` interface stay exactly as they are — they
  already correctly model "reconcile against whatever adapter is registered,
  Stub is a no-op" and cost nothing to keep. Removing them too would be
  churn with no behavior change, since Stub-only is already what an
  unconfigured deployment does today.
- Keep `LaneAgentResolver`/`StaticLaneAgentResolver` — repurpose it as the
  data source for the new mapping field below instead of deleting it.

**Status/mapping completion (the "give back the status" half):**
- Extend `getLaneStatuses()` to accept the resolver and add
  `multica_agent_ids: string[]` to each lane's returned object (empty array
  when no mapping is configured for that lane — never omit the field, so
  Pantheon can rely on its presence rather than checking for `undefined`).
- Thread the already-constructed `resolver` from `main.ts` into
  `createHttpServer`/`getLaneStatuses` the same way `rotationControllers` is
  already threaded through today — same pattern, no new plumbing shape.

**Documentation:**
- `docs/decisions/DEC-hdl-multica-disable-contract.md` (new, matching this
  repo's existing `DEC-*.md` pattern): records the verified Multica
  constraints from research-brief.md §3 (no zero-capacity, no non-destructive
  stop), the decision to retire rather than patch, and points at
  `pantheon-v2` as where the real lever now lives — so the next person who
  finds `heimdall#83` (or a future variant of the same question) has the
  real answer instead of re-deriving it. Includes a link to the Artifact
  (`https://claude.ai/code/artifact/dbe7d4f4-3f08-4021-b2e2-00c0d1a26778`)
  that already worked through the four options considered and rejected this
  session (grill U1) — linking prior analysis isn't the same as prescribing
  a conclusion from it, so this stays consistent with Open Question 1 below
  staying neutral on which option Pantheon should actually build.
- **Close `heimdall#83`** (grill U2) after merge — comment referencing the
  decision record and the merge commit/PR, then close. The issue is the
  epic's own stated trigger; leaving it open after the code path it
  describes no longer exists would be exactly the kind of tracker/reality
  drift this session has caught and fixed elsewhere.
- Update the now-stale header comments in `lane-agent-resolver.ts` and
  `control-adapter.ts` (both currently describe themselves purely in terms
  of feeding `MulticaControlAdapter`, which no longer exists).
- Remove `MULTICA_BASE_URL`/`MULTICA_WORKSPACE_ID`/`MULTICA_PAT_TOKEN` from
  `.env.example`; update the comment above `HEIMDALL_LANE_<N>_MULTICA_
  AGENT_IDS` to describe its new consumer (the status API) instead of the
  deleted adapter.
- `docs/vision.md`: check for any Goals-section language describing Heimdall
  as the actuator (item 4 in the standing backlog referenced "live end-to-end
  actuation verification" — this epic changes what that item even means, so
  it needs a rewrite or removal, not silent staleness).

**Explicitly not built here:** the real disable/enable lever logic
(throttle-vs-archive, severity-tiered or otherwise) against Multica's actual
constraints. That is Pantheon-side work, in `pantheon-v2`, against
`core/api/runners.ts` — a different repo, a different `task_tracking.repo`,
correctly out of this plan's scope per this skill's own repo-match gate.

## 4. What Could Go Wrong

- **A currently-working deployment silently loses real actuation it was
  relying on.** Mitigation: it wasn't real reliable actuation to begin with
  — every disable attempt has been 400ing since hda-03 shipped (heimdall#83
  itself is the proof). Nothing observably regresses; the only change is that
  the futile, silently-failing-forever call stops being attempted. Worth
  saying plainly in the decision record so nobody reads the deletion as a
  loss of working functionality.
- **Pantheon's facade doesn't actually consume the new `multica_agent_ids`
  field yet** because building that consumer is out of this epic's scope.
  Mitigation: this epic's job is to make the data available and correct, not
  to guarantee uptake — same relationship Heimdall already has with every
  other external consumer of `GET /lanes`. Flag it clearly as a real
  follow-up in the confirmation output, not a blocker here.
- **Deleting `circuit-breaker.ts` turns out to be used somewhere not caught
  by the repo-wide grep** (e.g. dynamic import, a script outside `src/`).
  Mitigation: `npm run build && npm test` after deletion is the actual gate,
  not the grep — the grep grounds the plan, the build/test run verifies it.
- **`.env.example` removal reads as "delete the operator's real Multica
  credentials."** It doesn't — `.env.example` is the template, not the
  operator's real `.env`; their real file is untouched by this epic (it's
  gitignored, was never in scope to edit here anyway).

## 5. Dependencies and Constraints

- Depends on nothing upstream — this is a subtractive change plus one
  additive API field, no new external dependency, no new package.
- Gates the real Pantheon-side follow-up epic (not built here): Pantheon's
  facade needs `multica_agent_ids` to exist in `GET /lanes` before it can
  correctly map lane status to a Multica agent ID on its own side.
- `MulticaAutopilotScheduler` and its env var are an explicit non-dependency
  — confirmed separate, confirmed untouched.

## 6. Open Questions

1. Should `docs/decisions/DEC-hdl-multica-disable-contract.md` also
   explicitly recommend the severity-tiered hybrid (Option C from the
   Artifact) as a starting point for Pantheon's own design, or stay neutral
   and just state the constraints? **Leaning:** state the constraints as
   fact (verified, not opinion) and mention the four options considered here
   as context, without prescribing Pantheon's own architecture — that
   decision belongs to whoever plans the Pantheon-side epic, with full
   context, not pre-decided from a document written before that planning
   happens.
2. Does `vision.md`'s backlog item 4 ("live end-to-end actuation
   verification against the real hive Multica") get rewritten to describe
   the new status-only relationship, or removed outright since Heimdall no
   longer has actuation to verify? **Leaning:** rewrite, not remove — the
   underlying goal (Heimdall-Multica integration actually working end to
   end) still matters, it's just satisfied differently now.

## 7. Verification Strategy

- `npm run build && npm test` after each deletion step — the real
  regression gate for "nothing else depended on this."
- A new/updated `main.ts` test (or `composeService()` integration test)
  confirming every lane's `controlAdapters` entry is `StubControlAdapter`
  regardless of whether `MULTICA_BASE_URL`/`WORKSPACE_ID`/PAT are set in
  `env` — proves the retirement is unconditional, not just
  default-unconfigured.
- A `getLaneStatuses()` unit test asserting `multica_agent_ids` is present
  and correctly populated for a lane with a configured mapping, and `[]` for
  one without.
- `ssh dostal@100.75.161.82 /Users/dostal/hive-ci/verify-heimdall.sh <sha>`
  — the real merge gate for this repo — before and after merge, per standing
  process.
- Live curl of `GET /lanes` post-merge confirming the new field is present
  in the real running response shape, not just in tests.

## 8. Scale Assessment

**Medium.** Multi-file (delete 3 files + 3 test files, edit `main.ts`,
`http-server.ts`, `.env.example`, `lane-agent-resolver.ts`,
`control-adapter.ts`, `vision.md`) and cross-layer (core actuation, service
wiring, HTTP API, docs) — same class as the routing/backoff-policy epics
that ran H/V. Lower architectural risk than those, though: no new
abstraction is being invented, most of the diff is deletion of an
already-isolated module plus one additive field on an existing endpoint.
Running a lightweight H/V (not the full elaboration a net-new subsystem
needs) to sequence the deletion-before-addition-before-docs order correctly,
then straight to stories.
