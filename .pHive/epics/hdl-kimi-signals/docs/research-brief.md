# Research Brief — hdl-kimi-signals

## Codebase findings

Identical wiring shape to `hdl-gemini-signals` (already proven twice now — Claude/Codex, then
Gemini): `PROVIDER_ADAPTERS` in `src/main.ts:37-41` is a plain object lookup keyed by
`lane.provider` (an open `string`, no type widening needed); `LanePipeline` and everything else
provider-agnostic. Minimal wiring is: two new adapter files + one `kimiAdapters()` factory in
`lane-pipeline.ts` + one registry line in `main.ts`.

## Kimi K3 signal surface (web research, 2026-08-13)

**Vendor**: Moonshot AI. The raw completions API is OpenAI-API-compatible —
`https://api.moonshot.ai/v1`, `Authorization: Bearer $MOONSHOT_API_KEY`
([Kimi API quickstart](https://platform.kimi.ai/docs/api/model)). This is the same auth
convention `active-probe/codex.ts` already uses (`authorization: Bearer <key>`), so
`active-probe/kimi.ts` follows codex.ts's shape more closely than Gemini's header-name
adaptation did.

**Active-probe candidate**: `GET https://api.moonshot.ai/v1/models` — the OpenAI-convention
list-models endpoint. **UNCONFIRMED** (flagged, same class of gap as codex.ts's own
file-header honesty note): no example curl for this specific endpoint was found in the docs
fetched, only the general host/auth pattern plus the standard OpenAI-API-compatible convention
Moonshot advertises. Treat as the reasonable default, same posture codex.ts already documents
for its own unconfirmed pieces.

**Much richer, typed error vocabulary than Codex's undocumented guesswork** — the
[Kimi Code error reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html)
documents `error.type` string values distinctly, not just HTTP status:
- `invalid_api_key` / `invalid_authentication` (401) → auth failed.
- `billing_quota_exhausted` (weekly cycle), `monthly_quota_exhausted`, `rolling_quota_exceeded`
  (5-hour rolling window) → longer-lived quota conditions, distinct from transient limits.
- `engine_overloaded`, `too_many_requests` → transient, retry-after-backoff conditions.
- 5xx-class (`database_connection_failed`, `downstream_unavailable`, etc.) → transient
  infrastructure, map to `down` like Claude's/Codex's/Gemini's 5xx handling.

These types were documented for "Kimi Code" (Moonshot's coding-assistant product, the closest
analog to Claude Code/Codex CLI that the north star's "2-5 Claude Code subscriptions" framing
already assumes) rather than the raw completions API specifically, but Moonshot's platform
appears to share one error taxonomy across products (the same `error.type` vocabulary is
referenced generically, not scoped to one product surface) — treated here as the best
available signal, same confidence tier as Gemini's error-code research.

**Partial reset-timestamp support — better than Gemini, matching Codex's existing pattern.**
The docs explicitly name a `Retry-After` header for the `engine_overloaded_error` case (only),
with no guarantee every 429 carries it. `active-probe/codex.ts` already has an established
precedent for exactly this shape: it reads `response.headers.get("retry-after")` and passes
the raw value straight through as `reset_at` with no relative→absolute conversion (a known,
already-accepted simplification, not something this epic needs to fix). `kimi.ts` mirrors that
exact simplification rather than inventing new conversion logic scope-creeping into this story.

**Public-status: real StatusPage.io feed exists — better fit than Gemini's incidents.json.**
`status.moonshot.cn` is confirmed Atlassian-Statuspage-hosted ("Powered by Atlassian
Statuspage" in the footer) with a working `api/v2/summary.json` JSON endpoint — the exact same
shape Claude's and Codex's adapters already consume. Confirmed component list (2026-08-13,
all "operational"): `Kimi`, `Website`, `Open API`, `API Service`, `Open Platform Portal`,
`SaaS`, `Sign In / Sign Up`, `File uploads`, `Search`, `Model`, `Vision Model`, `Thinking
Model`, `Text Model`, `Research Model`, `K2 Model`. No component named "K3" exists yet
(Moonshot's status page hasn't been updated for the K3 model generation this codebase targets)
— fragment-match broadly on `["API", "Model"]` (mirrors claude.ts's/codex.ts's own
intentionally-broad-but-documented fragment lists) so it catches `API Service`/`Open API` and
any current or future `*Model` component (including a future `K3 Model` line) without needing
per-model-version maintenance.

## Sources

- [Kimi API — model/quickstart docs](https://platform.kimi.ai/docs/api/model)
- [Kimi Code error reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html)
- [Kimi API rate limits guide](https://kimi-ai.chat/docs/rate-limits/)
- [Moonshot AI status page](https://status.moonshot.cn/)
- [Moonshot AI status JSON API](https://status.moonshot.cn/api/v2/summary.json)
