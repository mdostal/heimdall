# Grill Record — hdl-backoff-policies

**Source draft:** .pHive/epics/hdl-backoff-policies/docs/design-discussion.md
**CONTEXT.md substrate:** present (Terminology/Conventions unpopulated — reduced fidelity; Canonical reference docs/north-star.md)
**inconsistency_risk_signals:** absent (research-brief.md predates the signal field)
**round_number:** 1
**unresolved_count:** 4
**Generated:** 2026-08-19T04:00:00Z

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: 1 finding
- Convention violations: 1 finding
- Posture mismatches: not applicable

## Vocabulary mismatches

No findings. Terminology (backoff policy, consecutive suspect ticks, headroom, cost tier) is used consistently throughout, and CONTEXT.md has no populated Terminology section to contradict.

## Hidden assumptions

- **H1 (high)** — §3 items 2 and 4 describe all three policies (`static`, `progressive`, `exponential-progressive`) purely as functions of `consecutiveSuspectTicks`/`baseIntervalMs` — none of the three formulas given ("returns baseIntervalMs unconditionally", "baseIntervalMs * min(ticks, levelCap)", "min(baseIntervalMs * multiplier ** ticks, ceilingMs)") reference `resetAt` at all, even though the interface in item 1 explicitly includes `resetAt` in `BackoffContext`. The CURRENT, pre-epic behavior (`computeDelayMs`, researched in `research-brief.md`) treats a known `resetAt` as an *optimization that overrides the flat interval entirely* — "wait until reset_at, floored at intervalMs" is a very different number than a flat 5s poll for a lane that Heimdall already knows won't recover for another hour. As literally described, the new `static` policy would silently regress this: a known-`resetAt` lane would get probed every `baseIntervalMs` instead of waiting for its actual reset time, wasting probes and (for lanes with a distant reset_at) changing real behavior for every existing installation the instant this ships, even with `static` as the default.
  - Draft location: §3 items 1-2, and implicitly the "Migration required: no... every existing deployment behaves identically" claim in §8.
  - Why this matters: this directly contradicts §8's own "no migration, behaves identically until an operator changes a setting" claim — if `resetAt`-awareness isn't preserved, behavior changes for every deployment on day one, not just for operators who opt into a new policy.
  - Question for planner: is `resetAt`-awareness a hard invariant checked BEFORE the pluggable policy runs (the same tier as `auth_failed`, per §3 item 4's own precedent — "not a preference, a factual optimization"), or does every individual policy implementation need to fold `max(policyResult, timeUntilResetAt)` into its own formula? The draft needs to pick one and say so explicitly — right now it reads as neither.

- **H2 (medium)** — "Consecutive suspect ticks" (§3 items 1, 2, 5) is used as the growth variable for `progressive`/`exponential-progressive`, but a "tick" IS the scheduler's own poll interval — which the chosen policy itself is changing. Under `exponential-progressive`, tick 1 might be 5s later, tick 2 10s after that, tick 3 20s after that, etc. — the draft never states what real wall-clock span "10 levels" (progressive's cap) or a given `ceilingMs` (exponential's cap) actually cover once the growth is compounding on itself. This is exactly the kind of number the operator's own Artifact review asked to have shown plainly (named presets, not raw numbers with no framing) — the design discussion should work through at least one concrete example (e.g., "exponential at multiplier=2, ceiling=300s, base=5s reaches the ceiling after tick 7, roughly 10 minutes of cumulative wall-clock time from first going suspect") so a reviewer can sanity-check the actual behavior, not just the formula shape.
  - Draft location: §3 items 2, 8.
  - Why this matters: without a concrete wall-clock worked example, "Aggressive" vs. "Balanced" preset naming (§3 item 8) is a guess, not a grounded choice — the same problem the Artifact already flagged for the pre-pluggable-policy design.
  - Question for planner: work through real numbers for each of the 3 policies at their proposed defaults before finalizing preset copy/framing.

## Unresolved tensions

- **U1 (medium)** — §3 item 7 makes headroom/cost-tier "live-editable" via new dashboard fields, but never addresses input validation for the live-edit path. The EXISTING env-var parse path (`research-brief.md`'s "Headroom/cost-tier current state" section) explicitly warns-and-skips-the-whole-lane on a malformed value at process-start parse time — a very different failure mode than what a live HTTP `POST` from the dashboard should do (silently dropping a lane at runtime because of a bad live edit would be a much worse UX than the existing routing-strategy pattern's "reject with a structured 400, don't mutate state" — already established in this exact codebase per `research-brief.md`'s HTTP route research).
  - Draft location: §3 item 7 (no validation behavior specified at all).
  - Tension: the existing startup-time validation behavior (warn + skip lane) vs. the existing live-HTTP-edit validation behavior this codebase already uses elsewhere (`setRoutingStrategy`'s reject-with-400-on-invalid-name pattern) point to different, incompatible failure modes — the draft picked neither.
  - Question for planner: the live-edit path should reject an invalid headroom/cost-tier value with a structured 400 (mirroring `setRoutingStrategy`), never silently drop the lane — say so explicitly.

## Convention violations

- **C1 (medium)** — §3 item 6 states the reasoning for storing backoff-policy parameters as flat settings-table keys rather than a JSON blob: *"keeps every settings-table row a simple scalar, consistent with every existing row."* The same item then proposes storing the per-provider override as *"a second settings key holding a `Record<provider, policyName>` JSON map"* — a structured, non-scalar value in the exact same settings table, contradicting the stated principle within the same paragraph.
  - Draft location: §3 item 6.
  - Convention: the draft's own explicitly-stated principle, two sentences apart.
  - Question for planner: pick one consistently — either flat per-provider keys (e.g. `backoff_policy_override_claude`, `backoff_policy_override_codex`, ... — more rows, but matches the "every row is a scalar" principle the draft argues for elsewhere) or accept that the settings table can hold a structured JSON value when genuinely warranted (and drop the "simple scalar" framing as the stated reason for the flat-keys choice on parameters, since it wouldn't be true table-wide anymore).

## Posture mismatches

Not applicable — ordinary application code, no Hive-internal substrate involved.

## Notes

H1 is the load-bearing finding here: as currently drafted, this epic's actual code would ship a real, silent regression on day one (losing `resetAt`-aware scheduling for every lane, not just ones an operator opts into tuning) despite the design discussion's own explicit claim that nothing changes until an operator opts in. This needs to be resolved in the revision, not deferred as an open question.

## Addendum — collaborative review (post-H/V)

The H/V planning collaborative-review pass (run against horizontal-plan.md
and vertical-plan.md, per `hive.config.yaml`'s `planning.collaborative_review:
true`) surfaced three further real corrections, folded back into all three
documents:

- **H2 was only half-fixed by this grill pass**: the two worked-example
  formulas (`progressive` and `exponential-progressive`) used inconsistent
  indexing conventions for `consecutiveSuspectTicks` — one required
  0-indexed, the other 1-indexed, and as literally written the exponential
  formula didn't actually reproduce the stated numbers. Fixed by
  standardizing on a 1-indexed convention (first suspect tick = 1) and
  correcting the exponential formula to `multiplier ** (ticks - 1)`.
- A false claim that `ROUTING_STRATEGY_SETTING_KEY`/
  `getActiveRoutingStrategyName` live in `http-server.ts` — they actually
  live in `src/core/route-selector.ts`, with only `setRoutingStrategy` and
  the HTTP handlers in `http-server.ts`. The plan wrongly proposed putting
  the whole `BackoffPolicy` settings surface in the API layer; corrected
  to mirror the real split ownership.
- A wrong verification-plan citation: `test/sla-harness` does not exercise
  `InProcessScheduler`/`computeDelayMs` at all (its own header comment
  says so — it predates the scheduler's existence). The real regression
  suite for this behavior is `src/core/scheduler/in-process-scheduler.test.ts`
  (17 existing tests); all "must keep passing byte-identically" and
  "new test belongs here" references were corrected to point at it.

Noted here for the record — this grill pass's own scope (design-discussion
only) didn't reach the H/V documents or verify the worked-example
arithmetic against the actual formulas, so it couldn't have caught these;
the collaborative-review gate is what caught them, working as intended.

## Out of scope (this pass)

Grill does not propose solutions beyond what's noted inline, score quality, or gate work. H1's fix is straightforward (treat resetAt-awareness as a pre-policy invariant, same tier as auth_failed) — the planner should just say so.
