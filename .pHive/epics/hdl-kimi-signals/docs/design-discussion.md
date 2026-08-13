# Design Discussion — hdl-kimi-signals

## 0. Prelude

**NORTH STAR**: Kimi K3 is the fourth of the six named providers
(`Claude, Codex, Gemini, OpenRouter, Kimi K3, Ollama`) — after this epic, 4/6 have signal
adapters. Architecturally the closest fit yet: an OpenAI-API-compatible host with Bearer auth
(mirroring Codex exactly) and a real Atlassian-Statuspage-hosted status feed (mirroring
Claude/Codex exactly, better than Gemini's incidents.json workaround).

## 1. Goal

Add Kimi K3 (Moonshot AI) as a fourth supported lane provider, same shape as
`hdl-gemini-signals`: two adapters + one `PROVIDER_ADAPTERS` line, zero changes to
provider-agnostic code.

## 2. Proposed approach

**`active-probe/kimi.ts`** — `GET api.moonshot.ai/v1/models`, `Authorization: Bearer <key>`
(mirrors `active-probe/codex.ts`'s exact auth pattern). 429/403 bodies carry a typed
`error.type` (richer than Codex's own undocumented guesswork) distinguishing transient
(`engine_overloaded`, `too_many_requests` → `degraded`) from longer-lived quota exhaustion
(`billing_quota_exhausted`, `monthly_quota_exhausted`, `rolling_quota_exceeded` →
`out_of_credit`). `reset_at` reads the `retry-after` header when present, passed through
raw with no relative→absolute conversion — mirroring `codex.ts`'s already-accepted
simplification for the exact same header, not a new gap introduced by this epic.

**`public-status/kimi.ts`** — `status.moonshot.cn/api/v2/summary.json`, the same
StatusPage.io shape `claude.ts`/`codex.ts` already consume verbatim (component-level
`operational | degraded_performance | partial_outage | major_outage` indicators). Fragment
list `["API", "Model"]` — broad enough to catch the current component roster (`API Service`,
`Open API`, and every `*Model` component) without per-model-version maintenance, mirroring
the existing fragment-list tradeoff both prior adapters already accept.

**Wiring**: `kimiAdapters()` in `lane-pipeline.ts` + one `PROVIDER_ADAPTERS` line in
`main.ts` + one end-to-end test in `main.test.ts`, identical shape to `hdl-gs-03`.

## 3. Resolved open questions

1. **Which host — the raw Moonshot completions API or "Kimi Code" (the coding-CLI
   product)?** The raw API (`api.moonshot.ai`) — it's the credential surface a `lane`
   actually holds (an API key), matching how Claude's/Codex's lanes probe the raw
   Anthropic/OpenAI APIs rather than a specific CLI product's own auth flow. The richer
   `error.type` vocabulary documented for "Kimi Code" is used as the best available signal
   for what the shared Moonshot error taxonomy looks like (per research-brief.md), not as a
   claim that this epic integrates the Kimi Code CLI product specifically.
2. **How to handle `reset_at` from a relative `retry-after` header?** Pass it through raw,
   exactly like `codex.ts` already does for the identical header — this is an existing,
   accepted simplification in the codebase, not a new problem this epic needs to solve.

## 4. Risks

| Risk | Mitigation |
|---|---|
| `GET /v1/models` endpoint existence is unconfirmed (no example curl found, only the general host/auth convention) | Same accepted-gap posture as `codex.ts`'s own file-header honesty note — flagged in code comments, revisit once a live account confirms. |
| `error.type` vocabulary was documented for "Kimi Code" rather than the raw completions API explicitly | Treated as best-available signal (same confidence tier as Gemini's research); unrecognized/absent `error.type` defaults to `degraded`, never guesses `out_of_credit`. |
| No "K3"-named status-page component exists yet | Broad `["API", "Model"]` fragment match avoids needing a per-model-version update when Moonshot's status page catches up. |

## 5. Scale assessment

**Small** — direct mirror of `hdl-gemini-signals`'s proven shape. Proceeding to stories.
