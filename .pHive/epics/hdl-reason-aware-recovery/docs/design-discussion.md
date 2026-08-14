# Design Discussion — hdl-reason-aware-recovery

## Goal

Make lane recovery scheduling and actuation logging consume the `reason`/`reset_at` data Heimdall already captures, instead of treating status (`up`/`degraded`/`down`/`out_of_credit`) as the only signal. Concretely: when a lane's `reset_at` is known (e.g. a Claude/Codex rate-limit or credit exhaustion with a structured reset timestamp), schedule the next probe at that time instead of polling blindly every 5s; when `reset_at` is unknown, keep the existing periodic-retry fallback. Separately, thread `reason`/`reset_at` through to the actuation layer so blocking decisions can be logged with *why*, not just *that*.

Full technical grounding (current behavior verified against code, the operator's framing, and the CBA that led here) lives in [`docs/decisions/DEC-hdl-reason-aware-recovery.md`](../../../../docs/decisions/DEC-hdl-reason-aware-recovery.md) — this doc summarizes rather than re-derives.

## Non-goals

- **Not changing the block/allow binary.** The operator explicitly confirmed the existing `SUSPECT_STATUSES → max_concurrent_tasks: 0` mechanism is the correct "top-level direct traffic through or block" lever. This epic does not touch that decision logic — only what information flows alongside it.
- **Not the 429-specific `degraded` vs `up` question.** That's `DEC-hdl-429-corroboration.md`'s narrower, still-open question (superseded/generalized by this epic's reset_at work, but the specific "should a single Claude 429 read as degraded or up" call is a separate follow-up, not blocked by or required for this epic).
- **Not the lane-control UI or agent tooling.** Tracked as a separate future planning pass per `DEC-hdl-reason-aware-recovery.md`'s recommendation — UI-scale work needs its own `/plugin-hive:plan` run, not bundled here.

## Proposed approach

**Story 1 — reset_at-aware `InProcessScheduler` retry delay.** Read the current lane status's `reset_at` in `poll()`. If present and in the future, compute the next-poll delay as the time until `reset_at` (clamped to a sane floor so it never schedules *less* frequently than would help, and never negative/zero). If absent, keep today's flat `DEFAULT_INTERVAL_MS`. This is a delay-computation change inside the existing loop — no new `Scheduler` implementation, no new daemon, no HARD LAW risk.

**Story 2 — widen `ControlAdapter.reconcile` to carry reason/reset_at.** Change the interface from `reconcile(lane, status)` to pass the full `LaneStatus` (or add `reason`/`reset_at` params) so `MulticaControlAdapter.emitResult` can include why a lane is blocked in its Argus emission. `StubControlAdapter` also gets the richer context for its logging. The block/allow decision (`SUSPECT_STATUSES.has(status)`) is unchanged — this is purely additive context threading.

## Scale assessment

**Small.** Two isolated, well-understood files (`in-process-scheduler.ts`, `control-adapter.ts` + its one real implementation `multica-control-adapter.ts` + the `ControlAdapter` interface's one other consumer, `StubControlAdapter`), no new modules, no schema changes, existing test files to extend rather than new ones. Both stories are independently shippable and don't require H/V slicing — proceeding directly to stories.

## Risks

- **Story 2 changes a public interface** (`ControlAdapter.reconcile`'s signature) — both implementations (`StubControlAdapter`, `MulticaControlAdapter`) and every call site (`lane-pipeline.ts` or wherever `reconcile` is invoked per tick) must be updated together, or the build breaks. Mitigation: `npm run build` (tsc) will catch any missed call site immediately — this is exactly what strict TypeScript is for here.
- **Story 1's delay computation needs a floor.** If `reset_at` is in the past (clock skew, stale data) or very near-future, naively computing `resetAt - now` could produce a zero/negative/tiny delay and effectively busy-loop. Mitigation: clamp to `Math.max(DEFAULT_INTERVAL_MS, resetAt - now)` as `DEC-hdl-reason-aware-recovery.md` already specifies.

## Dependencies

None outside this repo. Both stories build on code already shipped (lane-health-status, hdl-scheduler, hdl-actuation epics, all merged to `main`).

## Open questions

None blocking — the two non-goals above are the deliberately deferred adjacent questions, not gaps in this epic's own scope.
