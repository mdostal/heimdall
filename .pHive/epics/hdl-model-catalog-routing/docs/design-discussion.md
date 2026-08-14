# Design Discussion — hdl-model-catalog-routing (slice 3 of 3)

## 0. Prelude

Closes the model-catalog trilogy (`hdl-model-catalog` slice 1 shipped the fetch/store/query
foundation; slice 2, dashboard toggles, is still open/optional; this is slice 3). This is the
piece that actually delivers the operator's original complaint's fix: *"we should KNOW when
a model is no longer available and turn on and off -- use newer models automatically...
Heimdalls job is to fix that and give that model and traffic back so that the other llms stop
calling stupid shit mistakenly."*

## 1. Goal

`GET /available-route`'s `model` field reflects a model that's actually usable right now —
if a lane's declared `HEIMDALL_LANE_N_MODEL` is disabled (operator choice, or defaulted-off
as an older generation) or has vanished from the provider's live catalog entirely, Heimdall
substitutes the newest enabled model for that provider instead of handing back a value the
provider will reject.

## 2. Proposed approach

**`model-catalog.ts`** gains `resolveEffectiveModel(store, provider, declaredModel):
{ model: string; substituted: boolean }`:
- Ungated provider (openrouter/ollama) → declared model, unchanged. Gating never applies to
  these (established in slice 1's scoping note — OpenRouter routes are explicit per-lane
  choices, Ollama has no deprecation concept).
- No catalog data at all for this provider (`getModelCatalog(provider).length === 0` — never
  refreshed) → declared model, unchanged. **No data means no opinion** — this is the byte-
  identical fallback that keeps every existing lane's behavior exactly as it was before this
  epic, until an operator actually runs a refresh.
- Declared model IS in the catalog AND enabled → declared model, unchanged (the common case
  once refreshed).
- Declared model is disabled, or absent from the catalog despite the provider having data
  (a real "this model doesn't exist anymore" signal) → substitute the most recently-created
  **enabled** model for that provider (`provider_created_at` desc; entries lacking a
  timestamp sort last — same recency-comparison logic slice 1's heuristic already uses).
  `substituted: true`.
- No enabled alternative exists at all → fall back to the declared model rather than
  returning nothing — a wrong-but-present model beats silently killing the whole route.

**`route-selector.ts`**'s `getAvailableRoute` calls this right before building the response,
replacing the bare `model: lane.model` assignment. `AvailableRoute` gains one field:
`model_substituted: boolean` — **never silent**, matching this codebase's consistent
precedent (every override/priority/reset-at feature always visibly flags when it's active
rather than changing behavior invisibly).

## 3. Resolved open questions

1. **Does this need routing-strategy changes?** No — substitution happens to the ALREADY-
   selected lane's model field, after `strategy.selectRoute` has already picked a lane by
   whichever strategy (priority/round-robin/off) is active. Orthogonal concern.
2. **What picks "best" among enabled alternatives?** Most recent `provider_created_at` —
   same recency signal slice 1's default-heuristic already established as this codebase's
   answer to "newest," for consistency rather than inventing a second ranking rule.
3. **Should the response show what was substituted FROM?** Not in this slice — `model_substituted:
   boolean` is the minimum "never silent" signal; the operator can already cross-reference
   `GET /models` for the full picture. Keeps the response shape change minimal.

## 4. Risks

| Risk | Mitigation |
|---|---|
| A caller hardcodes/caches the `model` field expecting it to always equal the lane's declared `HEIMDALL_LANE_N_MODEL` | This is precisely the behavior the operator asked for — a caller that wants the raw declared value can still read it from `GET /lanes`'s `model` field (unaffected, still the declared value) or `GET /models`; `/available-route`'s job is specifically "what should I actually use right now." |
| No catalog data yet (fresh install, no refresh run) means substitution silently never kicks in | Documented as the correct, intentional fallback — "no data, no opinion" — not a bug. An operator who wants substitution active needs to have refreshed at least once, same as every other catalog-dependent feature in this epic. |

## 5. Scale assessment

**Small.** One new function in `model-catalog.ts`, one call-site change in
`route-selector.ts`, one new response field. No schema changes, no new HTTP/MCP surface
(the query surface already shipped in slice 1). Proceeding directly to a single story.
