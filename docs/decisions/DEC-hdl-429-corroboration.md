# DEC-hdl-429-corroboration

**Status:** Superseded by [`DEC-hdl-reason-aware-recovery.md`](DEC-hdl-reason-aware-recovery.md) (2026-08-12) — narrowly scoped to Claude 429 handling in isolation; the operator's follow-up feedback reframed this as one instance of a general "status is not the only lever, use reason + reset_at everywhere" gap. Kept for the provenance/CBA analysis below, which the broader doc builds on rather than repeats.
**Type:** Understanding doc / CBA, not an accepted decision. Written to capture and reconcile in-progress work found on a separate machine checkout before it's lost, per operator request during Heimdall's re-kickoff standalone-deploy smoke test.

Referenced by: `src/core/signal-sources/active-probe/claude.ts`, `src/core/signal-sources/escalation.ts` (`resolveWithCorroboration`), `.pHive/epics/lane-health-status/docs/signal-inventory.md` (lhs-00 spike).

## Provenance — what was recovered and from where

During a re-kickoff standalone-deploy smoke test (2026-08-12), a git-checkout survey of `dostal@100.75.161.82` ("the hive" box) found two Heimdall-related artifacts not present anywhere else, alongside a fully redundant one:

1. **`/Users/dostal/.merge-work/heimdall`** — byte-identical to this repo's `main` (`5f80115`). No unique content. Redundant, not a loss risk.
2. **Commit `4ec66ef`** on a local `feat/PAN-7526` checkout at `/Users/dostal/Documents/work/dostal/code/heimdall`, dated 2026-08-08, **never pushed to `origin/feat/PAN-7526` and never part of any PR**. Confirmed via `gh pr list`: the real `feat/PAN-7526` work was **PR #6 ("PAN-7526: add available route endpoint"), already merged to `main`** on 2026-08-08 (`87a5335`). `4ec66ef` was added to that local branch checkout *after* the PR's real content, as a separate, never-shared experiment.
3. **An uncommitted working-tree change** on that same checkout, in `src/core/signal-sources/active-probe/claude.ts` — this is what this doc is about.

### Commit `4ec66ef` — evaluated and parked, not ported forward

`4ec66ef` ("seed lane status from `HEIMDALL_LANE_N_STATUS` env; declare real lanes") adds a startup block to `src/api/http-server.ts` that writes operator-declared lane status straight into the state store, bypassing signal probing entirely. Its own commit message says why: *"Until live signal detection (active probes, lhs-03\*) is wired..."*. That live signal pipeline **is now fully shipped** on `main` (the passive/public-status/active-probe → `status-model` pipeline this repo's README describes, verified working end-to-end in the 2026-08-12 standalone smoke test). Porting `4ec66ef` forward would regress real signal probing back to a static env-declared stub. **Not applicable anymore — left unmerged, no action needed.**

One non-code lesson worth naming: the commit's existence shows a recurring operator need — a way to pin a lane's declared status manually (e.g. while a new lane's signal adapter doesn't exist yet, or during a known outage) without waiting on live probing. That's a legitimate *future* feature (an explicit manual-override signal source, layered like `passive`/`public_status`/`active_probe` are today) — distinct from, and better-designed than, this stopgap's approach of overwriting the state store directly at startup. Not scoped further here; flagging for a future story if wanted.

## The open question: what should a Claude 429 resolve to?

### Current shipped behavior (`main`, unchanged by this doc)

`probeClaudeLane` (`src/core/signal-sources/active-probe/claude.ts:50-53`):

```ts
if (response.status === 429) {
  const resetAt = response.headers.get("anthropic-ratelimit-requests-reset");
  return { status: "degraded", reset_at: resetAt, reason: "rate limited (429)" };
}
```

Critically: `resolveWithCorroboration` (`src/core/signal-sources/escalation.ts:65-67`) only requires two-in-a-row agreement for `down`/`out_of_credit` verdicts (`requiresCorroboration`). **`degraded` is never gated by corroboration** — a single 429 flips the lane to `degraded` immediately, on the first read, every time.

### What the research spike actually said

`.pHive/epics/lane-health-status/docs/signal-inventory.md` (lhs-00), on Claude 429s specifically:

> multiple reported cases (e.g. anthropics/claude-code#22876) of 429s firing despite the usage dashboard showing available quota, across multi-account (Max) setups specifically. **Implication:** ... should NOT treat a single 429 as unconditionally authoritative for Claude Code lanes ... Recommend a short corroboration window (e.g. one retry after a brief delay) before flagging a Claude Code lane `down` from a 429 alone.

The spike's recommendation was about not jumping to **`down`** from a single 429 — which the shipped code already honors (429 never produces `down` directly, only `degraded`). It did not say what a single 429 should map to instead, and in particular did not address whether `degraded` itself should require corroboration. That gap is exactly what the uncommitted hive-box change is reacting to.

### The uncommitted proposal (hive box, not applied anywhere)

```diff
-    return { status: "degraded", reset_at: resetAt, reason: "rate limited (429)" };
+    return { status: "up", reset_at: null, reason: "429 seen but lane usable" };
```

Effectively: stop treating 429 as a signal at all — a rate-limited response still means the lane answered, so report it `up`.

### Cost/benefit of the three live options

| Option | Benefit | Cost |
|---|---|---|
| **A — keep current (429 → `degraded`, immediate, uncorroborated)** | Simple; surfaces every rate-limit event immediately, which is useful raw signal for `/lanes` observability even if noisy. No code change. | Directly reproduces the false-positive risk the spike flagged: a single false/transient 429 (documented as real for multi-account Max setups) flips a lane to `degraded` with zero corroboration — `/available-route` would then skip a lane that's actually fully usable, exactly the "false failures ... halt operations" pain point from `north_star.pain_points`. |
| **B — the uncommitted proposal (429 → `up`, signal discarded)** | Eliminates the false-positive risk entirely — a rate-limited-but-working lane is never wrongly excluded from routing. | Throws away a real signal completely, even genuine sustained rate-limiting. A lane truly saturated with 429s would report `up` indefinitely with no `reset_at`, no `degraded` warning at all — loses the "realistic downtime/health-check visibility" success criterion from `north_star.success`. Also inconsistent with Codex's usage-limit handling (not surveyed here) and with the two-tier `down`/`out_of_credit` corroboration pattern already established — this option doesn't reuse that pattern, it bypasses the state machine for this one signal type. |
| **C — extend corroboration to `degraded` from 429 specifically (not yet implemented anywhere)** | Matches the spike's actual design intent most closely: don't trust a single 429, but don't discard the signal either. First 429 → hold prior status (or a distinct uncorroborated marker) with `reason` noting an unconfirmed rate-limit; a second consecutive 429 → `degraded` for real. Reuses `resolveWithCorroboration`'s existing mechanism instead of adding a new one. | Requires widening `requiresCorroboration`'s definition or adding a parallel path for 429 specifically (429 isn't a `down`/`out_of_credit` verdict from `resolveStatus`, it's an active-probe adapter decision made before that stage) — more code than A or B, needs a design pass on where in the pipeline that corroboration state lives for `degraded` specifically (it's currently lane-pipeline-scoped for down/out_of_credit; would need the same per-lane "last verdict" memory extended to cover degraded-from-429). |

### Recommendation

Option **C** is the best fit for what the spike actually recommended and for `north_star.success` ("realistic downtime/health-check visibility"), but it's unbuilt — this doc doesn't implement it. Option **A** (current, unchanged) is defensible as "already better than the spike's literal `down` concern" and requires nothing. Option **B** (the uncommitted change) trades a real, sometimes-true signal for zero false positives — the CBA above doesn't clearly favor it, but the tradeoff is a judgment call about which failure mode (false-degraded vs. blind-up) hurts more in practice, which is the operator's call, not a code-correctness question.

**Awaiting operator decision:** keep A, implement C, or accept B's tradeoff explicitly (and if B, should Codex's equivalent 429/usage-limit handling — currently unexamined — get the same treatment for consistency?).

## Consequences (once a choice is made)

- Whichever option is chosen, update this doc's Status to Accepted and record the choice + reasoning here (matching this repo's other `DEC-*.md` records) — don't let the decision live only in a commit message.
- If C is chosen, it likely also affects the Codex/other-provider probe adapters (same false-positive class of problem), and should be designed as an `escalation.ts`-level concern rather than duplicated per-provider.
