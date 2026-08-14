# Research Brief — hdl-model-catalog

## Operator decision (2026-08-13, two rounds)

**Round 1** (the trigger): *"heimdall also needs to gate the models and things -- i'm
fucking tired of claude trying to call 2.5 gemini models that are full deprecated. gemini
says preview for the current shit, we should be able to hard define, open up, and give the
options on all of the available ones per there as well, heimdall needs to be the tokens,
routes, and things we use when we inject, call APIs, etc and ask -- what are my avaialble
models to call, what are my avaialable tokens and routes?"*

**Round 1 research finding**: no provider's list-models API exposes deprecation status —
not Claude, OpenAI, Gemini, or Kimi. Only OpenRouter has a sparse `expiration_date` field.
An artifact was presented recommending a git-tracked `config/model-catalog.yaml` (Option A).

**Round 2 correction** (the operator, after seeing the artifact): *"heimdall is an OSS tool
and a release pushes out to people, they install and use it. so, then they configure
settings and things locally, but heimdall cannot be fully configured to be locked down from
git. As such, it has to fetch all of the providers and locally have a config for turning
them on and off and then we could have some DEFAULTs we roll when setting it up -- but when
adding a gemini key for example, it should DEFAULT to only the newest ones but allow you to
turn on older available ones and stuff as well. This also pairs with the entirety of the
degraded and the other statuses of any route and models -- we should KNOW when a model is
no longer available and turn on and off -- use newer models automatically, etc. Heimdalls
job is to fix that and give that model and traffic back so that the other llms stop calling
stupid shit mistakenly and wasting tokens re-learning that gemini is on 3.x rather than
2.0."*

**Why the git-tracked-file design was wrong**: Heimdall ships as an OSS release — many
independent operators install it, each with their own provider keys and their own actual
model access. A file committed to the Heimdall repo can't reflect any individual
installation's real, current state, and updating it would require a new Heimdall release
every time a provider ships or retires a model — far too slow. The catalog has to be
**live-fetched per installation** (each operator's own credentials against the provider's
own live list-models endpoint) and stored **locally** (not git-tracked), exactly like
`manual_override`/`routing_strategy` already are in `StateStore`.

## Corrected design: live-fetch + local state + sane defaults + operator override

1. Fetch each configured lane's provider's live model list using that lane's own credential.
2. Store it locally in `StateStore` (gitignored SQLite, same place override/routing-strategy
   state already lives) — not git-tracked, per-installation.
3. When a model is seen for the first time, apply a **default recency heuristic** (see
   below) to auto-enable/disable it — "default to only the newest ones."
4. The operator can freely toggle any model on/off, same UX pattern as lane
   enable/disable/auto.
5. Re-fetching detects when a previously-known model **disappears** from the live list — a
   real, strong deprecation/retirement signal (stronger than any prose-doc claim), distinct
   from the existing up/down/degraded/out_of_credit lane-level status. Deferred to a later
   slice: automatically substituting the newest enabled model when a lane's declared one
   goes missing (route-selection change) — this epic (slice 1) builds the fetch/store/query
   foundation that makes that possible.

## Per-provider recency signal (confirmed via provider docs, 2026-08-13)

| Provider | List-models field | Recency signal | Recommendation |
|---|---|---|---|
| Claude | `GET /v1/models`, each entry has `created_at` (RFC 3339) | Anthropic's own docs state the list is **already returned newest-first** | Trust list order (or sort by `created_at` desc, belt-and-suspenders) |
| Codex/OpenAI | `GET /v1/models`, each entry has `created` (Unix timestamp) | Long-standing, widely-documented field | Sort by `created` desc |
| Kimi/Moonshot | `GET /v1/models`, OpenAI-compatible shape (stated, not directly confirmed against a live response in this research pass) | Assumed `created` field by API-compatibility claim | Sort by `created` desc when present; **fall back to "enable everything, let operator prune" if the field is absent** — never guess wrong |
| Gemini | `GET /v1beta/models`, each entry has `name`/`baseModelId`/`version`/`displayName` — **no date field at all** | None reliable from the API alone | Per-generation heuristic: extract the leading version number from `baseModelId`/`name` (e.g. `gemini-3` > `gemini-2.5`), prefer the highest; treat a `-preview`/`-latest` suffix as a same-generation tiebreak toward "newer." A real, accepted gap — documented, not hidden. |

**OpenRouter and Ollama are out of scope for this epic's gating concern**, by design, not
oversight:
- OpenRouter routes are already explicitly operator-declared per lane (a specific model
  slug chosen deliberately per `hdl-openrouter-signals`'s nested-gateway design) — there is
  no "Heimdall picked a stale default" failure mode the way there is for a bare
  `provider: "gemini"` lane declaring just `HEIMDALL_LANE_N_MODEL`.
- Ollama has no deprecation concept — it lists only what the operator has locally pulled
  (`hdl-ollama-signals`'s own scope note).

## Storage: `StateStore`, not a new file

Mirrors the existing pattern exactly — `manual_override`, `manual_reset_at`, and
`routing_strategy` (the `settings` table) already live in the same gitignored SQLite store
this epic adds a `model_catalog` table to. No new file, no new persistence mechanism, no new
operational surface to document/back up separately.

## Sources

- Round 1 artifact research (deprecation-field absence across Claude/OpenAI/Gemini/Kimi;
  OpenRouter's `expiration_date`).
- [Anthropic — list models](https://platform.claude.com/docs/en/api/models/list) — confirms
  `created_at` + newest-first list order.
- [Google — Gemini API models reference](https://ai.google.dev/api/models) — confirms no
  date field exists on a Gemini model entry.
- OpenAI's long-standing `GET /v1/models` `created` field (widely documented community
  convention, official reference page unreachable in this research pass — treated as
  standard, not novel).
- [Kimi API model docs](https://platform.kimi.ai/docs/api/model) — states OpenAI-format
  compatibility; exact field presence not directly confirmed against a live response in
  this research pass — verify during implementation, defensive fallback if absent.
