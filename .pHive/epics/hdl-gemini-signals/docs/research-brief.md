# Research Brief — hdl-gemini-signals

## Codebase findings

**Dispatch is a one-line-per-provider registry, not a switch.** `src/main.ts:37-40`:

```ts
const PROVIDER_ADAPTERS: Record<string, () => ProviderAdapters> = {
  claude: claudeAdapters,
  codex: codexAdapters,
};
```

`main.ts:122-134` looks up `PROVIDER_ADAPTERS[lane.provider]`; a lane whose provider has no
entry is skipped with a logged error (`main.test.ts` already covers this — "unknown provider
is skipped gracefully" — so adding `gemini` is additive, not a behavior change for existing
lanes). `Lane.provider` (`src/core/lane-registry.ts:13-24`) is an open `string`, not a
`"claude" | "codex"` union, so no type widening is needed.

`claudeAdapters()`/`codexAdapters()` (`src/core/lane-pipeline.ts:59-65`) each just bundle the
two adapter functions into a `ProviderAdapters { checkPublicStatus, probe }` pair.
`LanePipeline` itself never branches on provider — it only calls
`this.adapters.checkPublicStatus(...)` / `this.adapters.probe(...)`. So the full wiring for a
new provider is: two new adapter files + one `geminiAdapters()` factory + one registry line.
No changes to `Lane`/`LaneDeclaration`, `LanePipeline`, `route-selector.ts`, or any HTTP/MCP/UI
surface — none of those know about specific providers.

## Existing pattern to mirror (Claude, `src/core/signal-sources/`)

- **`public-status/claude.ts`**: hits `status.claude.com/api/v2/summary.json` (StatusPage.io,
  no auth), filters `components[]` by name fragment, maps `operational|degraded_performance|
  partial_outage|major_outage` → `up|degraded|degraded|down`.
- **`active-probe/claude.ts`**: `GET /v1/models` with `x-api-key` header (minimal-cost real
  call, never `--version`). 402 → `out_of_credit`; 429 → `degraded` + `reset_at` from the
  `anthropic-ratelimit-requests-reset` header; 401/403 → `down`; 5xx → `down`; 2xx → `up`.
- Both return the same shape regardless of provider (`PublicStatusSignal` /
  `ProbeResult`) — `passive.ts`/`escalation.ts` are provider-agnostic and need zero changes.

## Gemini signal surface (web research, 2026-08-13)

**No per-provider auth needed for the API surface itself** — Heimdall lanes use API keys
(`credential_ref`), matching the Gemini Developer API (`generativelanguage.googleapis.com`),
not Vertex AI's GCP-OAuth/project-based surface.

**Active-probe candidate**: `GET https://generativelanguage.googleapis.com/v1beta/models`,
auth via `x-goog-api-key` header (Google's current documented standard — the older `?key=`
query param form works but leaks the credential into URLs/server logs/proxies, so the header
form is the one to use, matching Claude's header-not-query pattern). This is the same
"list models" shape as Claude's probe — lightweight, real, no generation cost.
Source: [Gemini API reference](https://ai.google.dev/api/models), confirmed header form via
[Gemini API keys guide](https://ai.google.dev/gemini-api/docs/api-key).

**Error body is flatter than Claude's** — `{"error": {"code": <int>, "message": <string>,
"status": <string>}}`, where `status` is a snake_case enum. Two 429 sub-cases matter and are
distinguished by `status`, not by HTTP code alone (both are HTTP 429):
- `status: "RESOURCE_EXHAUSTED"` with message/reason indicating **per-minute rate limit** —
  transient, analogous to Claude's 429.
- Documented separately as **daily quota exceeded** — also 429, but a longer-lived condition
  closer to Claude's 402 out-of-credit.

  Source: [Gemini API error codes](https://ai.google.dev/gemini-api/docs/api-errors),
  [troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting).

**Gap: no reset timestamp.** Unlike Claude's `anthropic-ratelimit-*-reset` headers, the Gemini
Developer API does not document any response header or body field carrying an absolute reset
time for either 429 sub-case. `RetryInfo`/`retryDelay` exists in the *Vertex AI* error model
(GCP RPC-status style, per [Vertex AI 429 docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/provisioned-throughput/error-code-429))
but is not confirmed present on Gemini Developer API responses. **Design implication**:
`reset_at` must be `null` for every Gemini probe result — this is a real capability gap versus
Claude, not an oversight. `InProcessScheduler`'s existing reset_at-aware delay logic already
has a documented fallback to the flat polling interval when `reset_at` is unknown
(`hdl-reason-aware-recovery`), so this degrades gracefully rather than requiring new code.

**Public-status: no clean per-component feed exists for the Gemini API specifically.**
Checked `status.cloud.google.com/incidents.json` (Google Cloud's machine-readable incident
feed — no auth, no StatusPage.io-style scoping). Its `affected_products[]` list is
infrastructure-wide (VMware Engine, Bare Metal, NetApp, VPC, etc.) rather than a fixed
per-service component roster the way Claude's statuspage.io feed lists "Claude Code" /
"API" as named components. However, real Gemini-specific incidents **do** appear in it when
they occur — e.g. the 2026-02-27 04:36–06:45 incident, "Vertex AI Gemini API customers
experienced increased error rates when accessing the global endpoint," which named affected
products including Gemini/Vertex AI generative models
([incident source](https://status.cloud.google.com/incidents/5eu4DwAfjMPD5HKcFW2s)). So the
same fragment-filter approach Claude's adapter uses (`RELEVANT_COMPONENT_NAME_FRAGMENTS`)
still works — it just filters `affected_products[].title` in an incidents list instead of
`components[].name` in a component snapshot, and "no matching open incident" maps to `up`
(there is no explicit "operational" component entry to read for a not-currently-affected
product, only the absence of an open incident naming it).

## Sources

- [Gemini API reference — models.list](https://ai.google.dev/api/models)
- [Using Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key)
- [Gemini API error codes](https://ai.google.dev/gemini-api/docs/api-errors)
- [Gemini API troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting)
- [Vertex AI error code 429 (RetryInfo reference, not confirmed present on Developer API)](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/provisioned-throughput/error-code-429)
- [Google Cloud Service Health incidents feed](https://status.cloud.google.com/incidents.json)
- [Example real Gemini incident, 2026-02-27](https://status.cloud.google.com/incidents/5eu4DwAfjMPD5HKcFW2s)
