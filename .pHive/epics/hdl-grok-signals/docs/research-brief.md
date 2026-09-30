# Research Brief — hdl-grok-signals

## Codebase findings

Identical wiring shape to `hdl-kimi-signals` and `hdl-openrouter-signals`: `PROVIDER_ADAPTERS`
in `src/main.ts` is a plain object lookup keyed by `lane.provider`; `LanePipeline` and
everything else is provider-agnostic. Minimal wiring is: one new adapter file + one
`grokAdapters()` factory in `lane-pipeline.ts` + one registry line in `main.ts`. No public-status
adapter is created (see below — no confirmed machine-readable status feed found).

## xAI Grok Code API signal surface (research, 2026-09-27)

**Vendor**: xAI. Base URL: `https://api.x.ai/v1`. The API is explicitly documented as
OpenAI-API-compatible — `Authorization: Bearer $XAI_API_KEY`, same convention
`active-probe/kimi.ts` and `active-probe/codex.ts` already use.

**Active-probe endpoint**: `GET https://api.x.ai/v1/models` — the OpenAI-convention list-models
call. This is the cheapest real liveness call that confirms auth, identical in role to
`active-probe/kimi.ts`'s `GET https://api.moonshot.ai/v1/models`. No dedicated
key-introspection endpoint analogous to OpenRouter's `GET /api/v1/key` was found in the xAI
docs (the OpenAI-compatible surface is what xAI publicly documents) — UNCONFIRMED whether one
exists; `GET /v1/models` is treated as the reasonable default with the same honesty posture as
`kimi.ts`'s own unconfirmed-endpoint note.

**Error body format** — OpenAI-compatible shape confirmed in xAI docs:
```
{ "error": { "message": "...", "type": "...", "code": "..." } }
```
The distinguishing field is `error.code` (a string, not a numeric HTTP status repeat — contrast
with OpenRouter where `error.code` IS the numeric status). Confirmed code values from xAI
documentation and SDK sources:
- `invalid_api_key` (401) → auth_failed
- `insufficient_quota` (402) → out_of_credit / billing_error  
- `rate_limit_exceeded` (429) → degraded / rate_limit

**UNCONFIRMED** (flagged, same honesty posture as other adapters): whether xAI surfaces 402
specifically for credit exhaustion or uses a different HTTP status alongside `insufficient_quota`
code. The pattern matches the OpenAI convention (402 = payment required / quota exhausted),
which xAI explicitly follows — treated as the reasonable default. Both shapes are handled
defensively: a 401 with `error.code: invalid_api_key` plus an explicit 402 branch.

**Retry-After header for 429**: xAI rate-limit responses carry a `Retry-After` header (seconds),
same convention documented for OpenAI-compatible providers. `parseRetryAfter()` from
`error-parser.ts` is used for proper relative→absolute conversion — same fix the
`hdl-error-taxonomy` epic applied to `kimi.ts` and `codex.ts`.

**No usable public-status feed.** No Atlassian Statuspage or equivalent machine-readable JSON
endpoint was confirmed for xAI/Grok Code. The honest pattern (already established for OpenRouter
and Ollama) is an always-up stub for `checkPublicStatus` — truthful about there being no real
feed to check rather than fabricating one.

## Why not a richer key-introspection probe

OpenRouter's `/api/v1/key` gives credit balance in one call. xAI has no documented equivalent —
the only confirmed account-level introspection xAI surfaces is billing status inferred from 402
responses on real API calls. `GET /v1/models` is the correct minimal-cost signal: it confirms
auth, surfaces 401/402/429/5xx shapes that map cleanly to the ProbeResult contract, and makes
no actual inference calls.

## Sources

- [xAI API documentation — models endpoint](https://docs.x.ai/api/endpoints#list-models)
- [xAI API reference — authentication](https://docs.x.ai/docs/overview#authentication)
- [xAI error codes / OpenAI-compatible error format](https://docs.x.ai/api)
- xAI SDK source (`@xai-org/grok-sdk`) — confirms Bearer auth + OpenAI-compat error shape
