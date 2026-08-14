# Research Brief — hdl-openrouter-signals

## Operator decision (2026-08-13)

Presented as a Claude Artifact with two options; operator chose the gateway-with-nested-routes
shape over "one more flat lane" — verbatim: *"it should nest as a gateway with routes
underneath and we choose -- if we want kimi, we turn that on, if we want grok through there,
we turn that on, if we want to use open router to do anthropic, sure we turn that on -- but
usually if we set aside a pool of cash for that separately, we may want to control what routes
it gets and is able to judge .. so it should nest neatly -- and if we cannot do a gateway which
does the same things as the other parts of heimdall judging the gates, we need a bit of
refactoring for it."*

## Codebase findings — does the existing model support nesting? (dedicated Explore pass)

**Bottom line: the persistence/actuation layers need zero schema changes. Two narrow gaps
exist, both small.**

1. **`lane-registry.ts:13-24`** — `LaneDeclaration`/`Lane` already has a `model` field
   (defaults to `provider` if unset). `loadLaneDeclarations` (lines 26-50) has no cross-index
   uniqueness check at all — nothing compares `credential_ref` across declarations. **Multiple
   lane_ids sharing one `credential_ref` already works today, unmodified.**
2. **`state-store.ts`** — `lanes` table PK is `lane_id` only; every read/write
   (`upsertLane`, `recordStatus`, `setManualOverride`, `setManualResetAt`) is keyed exclusively
   by `lane_id`. `credential_ref`/`provider` are plain non-unique columns. **Multiple lanes
   sharing a credential each get fully independent status/override/reset_at rows — this is
   exactly the "we choose... turn that on" mechanism the operator asked for, and it already
   exists.**
3. **`EnvCredentialSource.resolve()`** — a stateless `env[credentialRef]` lookup, called once
   per lane. Two lanes resolving the same `credential_ref` each independently get the same
   secret string back. No changes needed.
4. **`lane-agent-resolver.ts`** — keyed by `lane_id`, not provider/credential — no uniqueness
   assumption to break.
5. **The real functional blocker**: `main.ts:39-43` — `PROVIDER_ADAPTERS` has no `openrouter`
   entry, and no `signal-sources/{active-probe,public-status}/openrouter.ts` exists. Any lane
   declaring `provider: "openrouter"` today is silently skipped (no pipeline, no scheduler,
   stuck at "down — unconfigured" unless the operator forces `manual_override: enabled`). This
   is the standard gap every provider epic in this loop has closed — not new to OpenRouter.
6. **A real but narrow gap**: `priority-strategy.ts`'s `RUNTIME_PRIORITY` is keyed by
   `provider` only. Since OpenRouter isn't in the table, every OpenRouter-backed lane gets the
   same "unranked" tie value regardless of which underlying model it targets — multiple
   OpenRouter routes rank identically to each other, distinguished only by an accidental
   `lane_id` alphabetical tie-break, not real operator intent. `route-selector.ts` reads
   `lane.model` only when building the selected route's response (line 80), never for
   candidacy/ranking.
7. **Cosmetic gap**: `dashboard.ts`'s `renderRow` shows `lane.provider` but no `lane.model`
   column — three `openrouter`-provider lanes would render as three rows all badged
   "openrouter" with no on-screen way to tell Kimi/Grok/Anthropic routes apart except reading
   the `lane_id` text itself.

## OpenRouter's actual signal surface (web research, 2026-08-13)

**`GET https://openrouter.ai/api/v1/key`**, `Authorization: Bearer <key>` — an account-level
key-introspection endpoint, richer than a bare "list models" liveness check:

```
{ data: { label, limit: number|null, limit_reset: string|null, limit_remaining: number|null,
  include_byok_in_limit, usage, usage_daily, usage_weekly, usage_monthly, byok_usage*,
  is_free_tier } }
```
Source: [OpenRouter API limits reference](https://openrouter.ai/docs/api_reference/limits).

- `402` = insufficient credits (account/key-wide) → `out_of_credit`.
- `429` = rate limited, carries `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset`
  headers. **UNCONFIRMED**: the exact `X-RateLimit-Reset` format (unix seconds vs ms vs
  something else) isn't documented — passed through raw as `reset_at`, same accepted-gap
  posture as `codex.ts`'s/`kimi.ts`'s own retry-after handling.
- Whether `GET /api/v1/key` itself can 402 at zero balance (vs. always 200 with
  `limit_remaining: 0`) is **unconfirmed** by the docs fetched — handled defensively (either
  response shape maps correctly: a 402 hits the explicit branch, a 200 with `limit_remaining
  <= 0` is read from the body).

**Per-route health is NOT independently observable from OpenRouter's API.** Confirmed via
[OpenRouter's provider-routing docs](https://openrouter.ai/docs/guides/routing/provider-selection):
"OpenRouter does not expose a dedicated lightweight health check endpoint... there's no
proactive API to query [per-route] status beforehand" — `only`/`order`/`ignore`/`sort` are
*request-time* routing preferences, not a per-route health signal to poll. This means every
lane sharing one OpenRouter credential will report the **same** underlying account-level
credit/rate-limit status — genuinely "judged" independently only in the sense that each lane's
corroboration/resolution state-machine runs independently per `lane_id` (already true of the
existing architecture), not because OpenRouter exposes distinct per-model health. This is an
honest, disclosed limitation, not an oversight.

**No usable public-status feed.** `status.openrouter.ai` exists and is real (components: Chat,
Data API, Homepage, Clerk/auth — all currently operational), but it's hosted on "OnlineOrNot"
rather than Atlassian Statuspage, and no JSON API endpoint was found in a reasonable search
(`/api/v1/summary` 404s; no documented machine-readable feed). Skipped for this epic — same
disciplined treatment given to any signal source that can't be confirmed working, revisit if a
JSON feed surfaces later.

## What satisfies "nest neatly" and "we choose... and is able to judge"

- **"We choose... turn that on"** → already fully supported: declare one lane per OpenRouter
  route (shared `credential_ref`, distinct `lane_id` + `model`), toggle each independently via
  the existing `manual_override` mechanism (`hdl-lane-override`). Zero new code.
- **"Nest neatly"** → the dashboard needs to show `model` so multiple same-provider,
  same-credential lanes read as a coherent group rather than three identical-looking rows.
- **"Is able to judge"** → once the `openrouter` adapter exists, every OpenRouter lane
  participates in routing-strategy candidacy exactly like any other lane (existing machinery,
  `hdl-routing-strategies`); the one real gap is `priority-strategy.ts` treating all OpenRouter
  lanes as rank-tied — worth a small, compartmentalized fix so operator intent (not
  `lane_id` alphabetics) decides which enabled OpenRouter route wins under the `priority`
  strategy.

## Sources

- [OpenRouter API limits & error codes](https://openrouter.ai/docs/api_reference/limits)
- [OpenRouter provider routing / selection guide](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter status page](https://status.openrouter.ai/)
