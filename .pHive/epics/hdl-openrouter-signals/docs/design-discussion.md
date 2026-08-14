# Design Discussion — hdl-openrouter-signals

## 0. Prelude

**NORTH STAR**: OpenRouter is the fifth of six named providers. Per the operator's explicit
decision (this epic's trigger), it is NOT modeled as one more flat lane like Claude/Codex/
Gemini/Kimi — it's a gateway credential fanning out into multiple independently-toggleable
"routes" (e.g. Kimi-via-OpenRouter, Grok-via-OpenRouter, Anthropic-via-OpenRouter), each
participating in the same override/routing/status machinery every other lane already uses.

**OPERATOR DECISION** (verbatim, resolving the design-options artifact presented for this
epic): *"it should nest as a gateway with routes underneath and we choose -- if we want kimi,
we turn that on, if we want grok through there, we turn that on, if we want to use open router
to do anthropic, sure we turn that on -- but usually if we set aside a pool of cash for that
separately, we may want to control what routes it gets and is able to judge .. so it should
nest neatly -- and if we cannot do a gateway which does the same things as the other parts of
heimdall judging the gates, we need a bit of refactoring for it."*

## 1. Goal

Make OpenRouter usable as a nested gateway: one credential, N operator-declared routes, each
independently on/off, each visibly grouped under its gateway on the dashboard, each
participating in real routing-strategy candidacy — using the existing per-`lane_id` machinery
wherever it already applies, and closing the two narrow gaps a dedicated research pass found
(see research-brief.md): no `openrouter` adapter exists yet, and `priority-strategy.ts` can't
tell same-provider routes apart.

## 2. Proposed approach

**The nesting itself needs no schema change.** `lane-registry.ts`/`state-store.ts` already key
everything by `lane_id`, with `credential_ref` and `provider` as plain non-unique columns —
confirmed by a dedicated codebase pass before this design was written. An operator declares one
`HEIMDALL_LANE_<N>_*` block per route, all pointing at the same `credential_ref`
(`OPENROUTER_TOKEN`), each with a distinct `lane_id` and `model` (e.g. `moonshotai/kimi-k3`,
`x-ai/grok-4`, `anthropic/claude-sonnet-4.5` — OpenRouter's own model-slug convention). Turning
a route on/off is the existing `manual_override` mechanism (`hdl-lane-override`) — zero new
code. Four stories close the remaining real gaps:

**`hdl-or-01`** — `active-probe/openrouter.ts`: `GET api.openrouter.ai/v1/key`, Bearer auth.
Richer than a bare list-models probe — one call returns both credit state (`limit_remaining`)
and rate-limit state. `402` / `limit_remaining <= 0` → `out_of_credit`; `429` → `degraded`
(raw `X-RateLimit-Reset` passthrough, format unconfirmed — same accepted-gap posture as
`kimi.ts`'s retry-after handling). No `public-status/openrouter.ts` — no confirmed
machine-readable status feed exists (research-brief.md); passive + this unusually rich
active-probe already exceed what Claude/Codex/Gemini/Kimi get from public-status alone.

**`hdl-or-02`** — wiring (`openrouterAdapters()` + one `PROVIDER_ADAPTERS` line), proven with an
end-to-end test that's the actual "nesting" proof: **two** lanes declared with the same
`credential_ref`, different `model`, each independently getting a real pipeline/scheduler and
independently recording status/override — demonstrating the gateway-with-routes shape works
today, not just in theory.

**`hdl-or-03`** — dashboard nesting. `getLaneStatuses` (`http-server.ts`) gains `model` and
`credential_ref` on the response (both already live on the in-memory `Lane` object, read via
`registry.get(status.lane_id)`, mirroring the exact pattern `credential_configured` already
uses — no new DB column, `credential_ref` is an env-var *name*, not a secret). The dashboard
groups rows sharing a `credential_ref` used by more than one lane under one gateway header,
showing each route's `model`; a `credential_ref` used by exactly one lane renders exactly as
today (zero visual change for Claude/Codex/Gemini/Kimi).

**`hdl-or-04`** — the one real "judging" gap. `priority-strategy.ts`'s `RUNTIME_PRIORITY` is
keyed by `provider` only, so every OpenRouter route ties for rank and falls back to
`lane_id`-alphabetical — an accident, not operator intent. Adds an optional
`HEIMDALL_LANE_<N>_PRIORITY=<int>` declaration (mirrors `manual_override`'s
override-wins-outright shape): when set, it replaces `runtimeRank`'s output for that lane
entirely; when unset, ranking is byte-identical to today. Lets the operator say "prefer my
OpenRouter/Kimi route over my OpenRouter/Grok route" directly, without inventing a new ranking
subsystem.

## 3. Resolved open questions

1. **Does nesting need a new data model (parent/child lane records)?** No — confirmed by
   research. `credential_ref`-sharing plus `model` differentiation, both already-existing
   fields, is sufficient; the "refactor" the operator anticipated turned out to be two small,
   compartmentalized additions (dashboard fields + an opt-in priority override), not a
   structural change.
2. **Can OpenRouter routes be independently health-judged from OpenRouter's own signals?** No
   — OpenRouter doesn't expose per-route health/quota (research-brief.md, confirmed against
   OpenRouter's own provider-routing docs). Every route sharing a credential reports the same
   underlying account-level credit/rate-limit state. Disclosed honestly rather than
   fabricating per-model signals OpenRouter doesn't provide. Each route's *resolution*
   (corroboration, override, priority) still runs independently per `lane_id` — that part of
   "judging" is real and unaffected by the shared-signal limitation.
3. **Public-status for OpenRouter?** Skipped — a real status page exists
   (`status.openrouter.ai`) but no confirmed JSON API was found. Same disciplined
   accept-the-gap posture as any unconfirmed signal source in this codebase; revisit if a
   feed shape is confirmed later.

## 4. Risks

| Risk | Mitigation |
|---|---|
| `X-RateLimit-Reset` format unconfirmed | Raw passthrough, documented, same accepted-gap class as `codex.ts`/`kimi.ts`. |
| `GET /api/v1/key`'s exact 402-vs-200-with-zero-remaining behavior unconfirmed | Both response shapes are handled explicitly in the adapter — an actual 402 hits its own branch; a 200 body is also checked for `limit_remaining <= 0`. |
| `HEIMDALL_LANE_<N>_PRIORITY` could be misused to silently starve a lane the operator forgot was deprioritized | Surfaced on the dashboard next to the route (same "never silent" precedent as the existing manual-override badge). |
| Dashboard grouping logic adds a new branch (grouped vs ungrouped) that could regress the ungrouped (single-lane-per-credential) rendering for every existing provider | Explicit acceptance criterion: every current Claude/Codex/Gemini/Kimi dashboard test passes with zero visual/DOM change when `credential_ref` is unique. |

## 5. Scale assessment

**Medium** — four stories across three layers (signal-source, routing-strategy, HTTP+dashboard
UI), but every story mirrors an established pattern from this same loop (provider adapter =
Gemini/Kimi's shape; opt-in override field = `manual_override`'s shape; registry-sourced
response field = `credential_configured`'s shape) — no new architecture, so proceeding directly
to stories without a full H/V pass, consistent with `hdl-routing-strategies`' own medium-scope
precedent.
