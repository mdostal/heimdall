# Design Discussion — hdl-backoff-policies

## 1. What Are We Doing?

`docs/vision.md`'s "Goals" section has flagged two items as "needs an
operator call, not a routine pass" since the error-taxonomy epic shipped:
probe-cadence backoff tuning, and headroom/cost-tier defaults. Both were
scoped in a prior Artifact review; the operator's own steer replaced "pick
one tradeoff" with "make it a pluggable, tunable architecture" — a
`BackoffPolicy` abstraction, selectable and configurable, extensible with
more policies later, shipping 3 to start: **static** (today's flat
interval, unchanged behavior as the default), **progressive** (steps up by
a rule each consecutive suspect tick, capped at ~10 levels), and
**exponential-progressive** (multiplies per tick, with a hard ceiling —
must have a stop point, never unbounded).

Headroom/cost-tier get the smaller companion fix: move from invisible
env-var-only defaults to live-editable per-lane settings, mirroring how
`manual_override`/`manual_reset_at` already work. Automatic headroom
inference (the fancier idea vision.md floated) is explicitly deferred —
this epic ships manual tunability only.

"Done" looks like: an operator picks a backoff policy by name in Settings
(global, with an optional per-provider override), sees what tradeoff
they're accepting against the 10-second SLA, and can adjust a lane's
headroom/cost-tier live without editing `.env` or restarting the service.

## 2. What I Found

- `InProcessScheduler.computeDelayMs()` (`src/core/scheduler/
  in-process-scheduler.ts:83-100`) is the exact logic to replace: `auth_failed`
  → fixed 5-min; known `reset_at` → wait for it, floored at the interval;
  otherwise → flat 5s. `poll()` tracks no consecutive-suspect counter today
  — new stateful tracking is required, and it must reset to 0 the instant a
  lane recovers (an existing, load-bearing guarantee, not something this
  epic gets to relax).
- `manual_reset_at` already wins outright over everything else in this
  file's precedence chain — the new pluggable policy must slot in *below*
  that, never override it.
- This codebase already has a proven pluggable-strategy pattern
  (`src/core/routing-strategies/`: interface + one-file-per-strategy +
  registry factory + settings-table persistence + HTTP routes + dashboard
  picker) — I'm copying this shape exactly for `BackoffPolicy`, not
  inventing a new one.
- `manual_override`/`manual_reset_at` on `StateStore` (defensive `ALTER
  TABLE ADD COLUMN`, `setX`/`getX` pairs, operator-value-wins-over-default
  precedence) is the direct precedent for headroom/cost-tier's new
  per-lane editability.
- The one real gap in precedent: the `settings` table's existing rows are
  all simple scalars (theme name, strategy name, a boolean). There's no
  existing example of storing a *structured* multi-field config (like
  exponential's multiplier + ceiling) in that table — `policy-loader.ts`'s
  `Policy` type is the closest structured-config example in this codebase,
  but it's YAML-file-loaded, not settings-table-stored. This needs a real
  decision (§3 below), not a copy-paste.
- Provider-published rate-limit info is thinner than the phrase "surface
  known SLAs" implies: only Claude and OpenRouter expose anything live and
  parseable today (already-parsed headers, not currently displayed);
  Codex/Kimi/Gemini are reactive-only; Ollama has no concept of limits at
  all. The UI needs to say "not published by provider" honestly rather
  than inventing numbers for the rest.

## 3. My Proposed Approach

1. **`src/core/scheduler/backoff-policies/types.ts`** — the `BackoffPolicy`
   interface. Shape (revised post-grill — see §4/§6 below):
   `nextDelayMs(ctx: BackoffContext): number` where `ctx =
   { consecutiveSuspectTicks, baseIntervalMs, config }`. **No `errorCode`
   or `resetAt` in context** — both are handled as pre-policy invariant
   checks (item 4 below), not policy inputs, so every policy only ever
   sees the "ordinary self-healing error, no known reset time" case.
   `config` is the policy's own resolved parameters (empty object for
   `static`). **`consecutiveSuspectTicks` is 1-indexed** — the FIRST tick a
   lane is found suspect passes `1`, not `0` (incremented before
   `nextDelayMs` is called, not after). This is an explicit, load-bearing
   convention — see the indexing note below, added after the collaborative
   review pass caught the two policy formulas silently assuming different
   conventions in an earlier draft.
2. **Three policy files**, mirroring `priority-strategy.ts`'s one-file
   style: `static-backoff.ts` (returns `baseIntervalMs` unconditionally —
   today's behavior, byte-identical default), `progressive-backoff.ts`
   (`baseIntervalMs * min(consecutiveSuspectTicks, levelCap)`, `levelCap`
   default 10), `exponential-progressive-backoff.ts` (`min(baseIntervalMs *
   multiplier ** (consecutiveSuspectTicks - 1), ceilingMs)` — note the
   `- 1`, required precisely because `consecutiveSuspectTicks` is
   1-indexed, so the first suspect tick (`consecutiveSuspectTicks = 1`)
   still yields the un-multiplied `baseIntervalMs`, matching `static`'s
   very first delay exactly, only diverging from tick 2 onward — the
   ceiling is mandatory, not optional, per the operator's explicit "say
   when to stop so put a limit on it"). **Worked example (grill H2,
   corrected post-collaborative-review — the first draft's two formulas
   used inconsistent indexing and produced numbers that didn't actually
   match each other's stated convention):** at the proposed defaults
   (`multiplier=2`, `ceilingMs=300_000`, `baseIntervalMs=5_000`),
   exponential's delay sequence by tick is 5s (tick 1) → 10s (tick 2) →
   20s (tick 3) → 40s (tick 4) → 80s (tick 5) → 160s (tick 6) → 300s,
   capped (tick 7 onward) — roughly 10 minutes of cumulative wall-clock
   time from first going suspect to hitting the floor of "check every 5
   minutes." Progressive's delay sequence is 5s, 10s, 15s, ... 50s (tick
   10, `levelCap` reached) then holds at 50s — cumulative time to reach
   tick 10 is `5+10+...+50 = 275s`. Both sequences now use the same
   1-indexed `consecutiveSuspectTicks` convention and both sets of numbers
   are independently re-derivable from the formulas above — not just
   asserted. These numbers — not the raw formulas — are what the
   dashboard's preset copy should actually show.
3. **`registry.ts`** — `createBackoffPolicyRegistry(): Record<string,
   BackoffPolicy>`, same factory shape as routing-strategies' registry.
4. **Two hard invariants, checked BEFORE the pluggable policy runs, same
   tier, in this order** (revised post-grill — grill H1 found the original
   draft's policies silently ignoring `resetAt`, which would have
   regressed existing behavior for every installation on day one, not just
   installations that opt into a new policy):
   1. `errorCode === "auth_failed"` → fixed `AUTH_FAILED_BACKOFF_MS`
      (unchanged from today).
   2. a known `resetAt` → wait until it, floored at `baseIntervalMs`
      (unchanged from today — this is a factual "we already know when this
      recovers" optimization, not a backoff heuristic preference, so it
      doesn't belong in the pluggable-policy surface any more than
      `auth_failed` does).
   Only when NEITHER applies does `computeDelayMs` delegate to the
   selected `BackoffPolicy.nextDelayMs()` — meaning every policy
   implementation only ever handles the "ordinary self-healing error, no
   known reset time" case, which is also why `errorCode`/`resetAt` were
   dropped from `BackoffContext` in item 1 above.
5. **`InProcessScheduler` gains a `consecutiveSuspectTicks` instance
   field**, incremented in `poll()` **before** the delay computation
   whenever `stillSuspect` (so the first suspect tick sees `1`, per item 1
   above's 1-indexed convention), reset to 0 otherwise — right next to the
   existing `stillSuspect` computation, so the reset-on-recovery guarantee
   is visibly preserved in the same place it's already documented.
6. **Settings-table persistence, mirroring `routing_strategy`'s real,
   split ownership exactly (corrected post-collaborative-review — the
   first draft wrongly attributed the whole pattern to `http-server.ts`;
   in reality `ROUTING_STRATEGY_SETTING_KEY` and
   `getActiveRoutingStrategyName` live in `src/core/route-selector.ts`,
   the core file that actually consumes the active strategy, and only
   `setRoutingStrategy` + the HTTP handlers live in `http-server.ts` —
   core owns the setting key and its own read access, the API layer owns
   writes and the wire format), every row a simple scalar (revised
   post-grill — grill C1 caught the original draft proposing a JSON-map
   row for the per-provider override in the same breath as arguing every
   row should stay scalar)**:
   `BACKOFF_POLICY_SETTING_KEY` and `getActiveBackoffPolicyName` live in
   `src/core/scheduler/backoff-policies/registry.ts` (the core file
   `InProcessScheduler` actually imports from — global choice, default
   `"static"`, the safe, behavior-preserving default), `setBackoffPolicy`
   and the `GET`/`POST /backoff-policy` HTTP routes live in
   `http-server.ts`. Per-provider override: one flat settings key per provider
   (`backoff_policy_override_claude`, `backoff_policy_override_codex`, ...
   — six keys, one per known provider, each an optional scalar; absent or
   null falls through to the global choice), not a JSON map — consistent
   with every other row in the table, including the policy parameters
   below. Policy-specific parameters (progressive's `levelCap`,
   exponential's `multiplier`/`ceilingMs`) stored as their own flat
   settings keys with sane defaults, each independently GET/POST-able.
7. **Headroom/cost-tier**: new `manual_headroom`/`manual_cost_tier`
   columns on `lanes` (defensive `ALTER TABLE ADD COLUMN`, same idempotent
   pattern), `setManualHeadroom`/`getManualHeadroom`,
   `setManualCostTier`/`getManualCostTier`. `lane-registry.ts`'s existing
   env-var value becomes the fallback default when no manual value is set
   — same precedence shape as `manual_override`. `scored-strategy.ts`'s
   `headroom_floor` gating reads the resolved (manual-or-default) value.
   **Live-edit validation (revised post-grill — grill U1 found no
   validation behavior specified)**: the `POST` route rejects an invalid
   headroom (non-finite/negative number) or cost-tier (not one of
   low/medium/high) with a structured 400, mirroring `setRoutingStrategy`'s
   `{error, ...}` shape exactly — it must NEVER silently drop the lane the
   way a malformed startup-time env var does. Startup-time parsing and
   live-edit validation are deliberately different failure modes for
   different failure moments: a bad `.env` value at boot has no operator
   watching a response, so warn-and-skip-the-lane is the safe choice; a bad
   live HTTP edit has an operator right there who should get an immediate,
   actionable rejection instead.
8. **Dashboard**: new "Probe backoff" section in Settings — named-preset
   framing (`Conservative` = static, `Balanced` = progressive,
   `Aggressive` = exponential, an "Advanced" toggle revealing the raw
   parameters) so the SLA tradeoff stays framed, not a bare number picker.
   Per-lane headroom/cost-tier become editable fields directly in the
   existing lane rows (mirroring the manual-override/reset-at controls
   already there), with a "manual" badge when set, matching every other
   override surface in this dashboard.

## 4. What Could Go Wrong

- **Breaking the "backs off immediately on recovery" guarantee** —
  **high**. This is the single most safety-critical property of the
  existing scheduler, explicitly documented in two places
  (`in-process-scheduler.ts`'s header comment,
  `docs/scheduler-constraints.md`). The new consecutive-tick counter must
  reset to exactly 0 the instant a lane is no longer suspect — this needs
  a real, explicit test, not just code review.
- **A default choice that silently violates the 10-second SLA** —
  **medium**. `static` staying the DEFAULT policy (byte-identical to
  today) sidesteps this for anyone who doesn't touch the setting; the risk
  is scoped to an operator who explicitly picks `progressive`/`exponential`
  without understanding the tradeoff — mitigated by the named-preset
  framing in §3 item 8, but worth a real SLA-harness check against the
  "Aggressive" preset's actual numbers before shipping it as a preset
  rather than just an advanced raw option.
- **Per-provider override semantics ambiguity** — **medium**. "Override
  the whole policy" vs. "override one parameter of the global policy" are
  different mental models; picked "whole policy" for simplicity (§3 item
  6), but this is worth confirming isn't surprising once the UI exists.
- **Settings-table row-count growth** — **low**. Flat keys per policy
  parameter (§3 item 6) means several new rows instead of one JSON blob;
  more rows but each independently simple, consistent with every existing
  row — a deliberate tradeoff, not an oversight.

## 5. Dependencies and Constraints

- Depends on nothing external — pure application-layer change, no new
  runtime dependency, no infra/hosting/CI involvement (unlike the last two
  epics).
- **Corrected post-collaborative-review**: `test/sla-harness` does NOT
  actually exercise `InProcessScheduler`/`computeDelayMs` at all — its own
  header comment states it drives `LanePipeline.refresh()` ticks directly
  because "no scheduler exists yet in this codebase," a scope note that
  predates the scheduler's own existence and was never updated. The real,
  already-existing regression suite for the exact behavior this epic
  touches is `src/core/scheduler/in-process-scheduler.test.ts` (17 tests
  covering `auth_failed`/`resetAt`/`manual_reset_at` precedence) — that
  file, not `test/sla-harness`, is what must keep passing byte-identically
  since `static` stays the unchanged default, and is where Slice 3's new
  reset-on-recovery test belongs.
- No migration for existing installations: new `lanes` columns default to
  NULL (falls through to existing env-var behavior), new settings-table
  keys default to `static`/current numeric defaults — every existing
  deployment behaves identically until an operator explicitly changes a
  setting.

## 6. Open Questions

(Post-grill note: a real adversarial pass — `.pHive/epics/hdl-backoff-policies/docs/grill-record.md`
— found 4 real issues in the first draft: policies silently ignoring
`resetAt` [a real regression risk, high severity], missing wall-clock
framing for the level/ceiling numbers, a self-contradiction between the
"scalar rows only" principle and a proposed JSON-blob settings row, and no
stated validation behavior for the new live-editable headroom/cost-tier
fields. All four are resolved directly in §3 above, not left as open
questions — see §3 items 2, 4, 6, 7 for the revisions.)

1. Should the per-provider backoff-policy override replace the whole
   policy, or override just specific parameters of the globally-selected
   policy? Leaning toward whole-policy-replacement (§3 item 6) for
   simplicity — a provider that needs a different heuristic entirely
   (not just different numbers) is the more likely real use case (e.g.
   Ollama, which never rate-limits, might reasonably want `static` even
   when the global default is `exponential`).
2. Exact wording for the dashboard's "Conservative/Balanced/Aggressive"
   preset copy — the underlying numbers are now grounded (§3 item 2's
   worked example: exponential reaches its 5-minute ceiling at ~10
   cumulative minutes, progressive reaches its 50s max at ~275 cumulative
   seconds), but the actual preset names/copy are still a draft, not
   confirmed with the operator.
3. Should `progressive`'s step size be additive (`base * min(ticks,
   levelCap)`, linear growth per level) or use an explicit lookup table of
   10 hand-tuned values? Leaning toward the simple multiplicative formula
   for v1 — a lookup table is easy to add later as a 4th policy if the
   simple formula proves too coarse, without touching the interface.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: node --test (existing unit test runner), src/core/scheduler/
         in-process-scheduler.test.ts (the real existing regression suite
         for this behavior — corrected post-collaborative-review from an
         earlier, wrong reference to test/sla-harness, which doesn't
         exercise the scheduler at all — must keep passing byte-identically
         against the unchanged `static` default), real dashboard load via
         Playwright for the new Settings controls and per-lane editable
         fields.
  Platforms: N/A (backend + dashboard only, no new platform surface).
  Automated: BackoffPolicy registry + all 3 policy implementations (pure
         functions, easy to unit-test exhaustively including boundary
         ticks at the level cap / ceiling), the consecutive-tick counter's
         reset-on-recovery behavior (the highest-risk item — needs a
         dedicated test simulating suspect→healthy→suspect again),
         settings-table persistence + HTTP routes (mirroring existing
         routing-strategy test coverage), StateStore migration + get/set
         pairs for the two new lane columns.
  Manual/live: real dashboard interaction confirming the policy picker,
         per-provider override, and per-lane headroom/cost-tier fields all
         round-trip correctly against a real running server.
  Not verifying: automatic headroom inference (explicitly deferred, no
         code exists yet to test), live behavior against real provider
         rate limits over a long observation window (out of scope for this
         epic — the policies are pure scheduling math, not provider-
         specific tuning).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~14-16 (new src/core/scheduler/backoff-policies/{types,
    static-backoff, progressive-backoff, exponential-progressive-backoff,
    registry}.ts + tests, in-process-scheduler.ts + test changes,
    state-store.ts + test changes for the 2 new columns, http-server.ts +
    test changes for the new routes, lane-registry.ts / scored-strategy.ts
    for the manual-value precedence read, dashboard.ts for the new
    Settings section + per-lane fields)
  Subsystems: scheduler core (SLA-critical), settings persistence, HTTP
    API, dashboard UI, lane registry/routing-strategy consumption
  Migration required: no (additive; every new column/setting defaults to
    current behavior)
  Cross-team coordination: no (single repo, single operator)
  Unknowns: 3 (open questions above) — none architecture-blocking, all
    refinement-level

  RECOMMENDATION: Needs H/V planning (Medium scope) before story
    decomposition — not structured outline (bounded to one repo, no
    migration, no new external dependency, well-understood after this
    research pass).
  RATIONALE: Cross-stack (scheduler core + settings + HTTP + dashboard UI)
    touching SLA-critical existing behavior that needs explicit sequencing
    (the pluggable architecture must exist and be proven safe before the
    dashboard exposes it to an operator) — a plain design discussion isn't
    enough to slice this safely, but it's also bounded enough that full
    structured-outline elicitation isn't warranted.
```
