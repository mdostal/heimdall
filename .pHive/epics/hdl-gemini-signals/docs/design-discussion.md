# Design Discussion — hdl-gemini-signals

## 0. Prelude

**NORTH STAR** (`.pHive/project-profile.yaml`):
- Goal: health-aware LLM/lane router spreading agent work across providers by headroom.
- Scale: multiple accounts across Claude, Codex, **Gemini**, OpenRouter, Kimi K3, Ollama.
- Pain points: manual runtime/token juggling; silent runtime hangs producing false failures.

This epic closes the largest concrete gap against that scale target: `src/core/signal-sources/`
has adapters for exactly 2 of the 6 named providers. Gemini is next in the north star's own
provider list and — unlike OpenRouter (an aggregator/gateway, different signal shape entirely)
or Ollama (local, no "credit"/"quota" concept at all) — Gemini is architecturally the closest
fit to the existing Claude/Codex pattern: a hosted API with a real API-key credential, real
rate-limit/quota states, and a vendor status surface. It's the right next provider to prove the
adapter pattern generalizes before tackling providers that need a genuinely different signal
model.

## 1. Goal

Add Gemini as a third supported lane provider by implementing the two adapter layers the
existing `ProviderSignalAdapter` shape requires (`public-status`, `active-probe`), and wiring
them into the one real dispatch point (`PROVIDER_ADAPTERS` in `src/main.ts`). No changes to
`passive.ts`, `escalation.ts`, `LanePipeline`, route selection, HTTP/MCP/UI surfaces, or the
`Lane`/`LaneDeclaration` types — all of that is already provider-agnostic by construction
(confirmed in research-brief.md).

## 2. Proposed approach

Mirror `signal-sources/{public-status,active-probe}/claude.ts` file-for-file, adapted to
Gemini's actual documented behavior (see research-brief.md for sourcing):

**`active-probe/gemini.ts`** — `GET generativelanguage.googleapis.com/v1beta/models`, auth via
`x-goog-api-key` header (not the `?key=` query param — a credential in the URL risks appearing
in proxy/access logs, and Google's own current docs recommend the header form). Response
mapping:
- 2xx → `up`
- 401/403 → `down` (auth failed)
- 429 → parse the JSON body's `error.status`; a per-minute-limit signal → `degraded`; a
  daily-quota-exceeded signal → `out_of_credit`. **`reset_at` is always `null`** — the Gemini
  Developer API does not document a reset-timestamp header or field the way Claude's
  `anthropic-ratelimit-requests-reset` does. This is a real capability gap versus Claude, not
  an implementation shortcut: `InProcessScheduler` already falls back to its flat polling
  interval whenever `reset_at` is unknown (`hdl-reason-aware-recovery`), so Gemini lanes simply
  never get the reset_at-aware fast-recovery optimization Claude lanes get. No new code needed
  to handle this gracefully — it's the existing designed fallback path.
- 5xx → `down`
- network failure → `down` (matching Claude's `try/catch` shape)

**`public-status/gemini.ts`** — `GET status.cloud.google.com/incidents.json` (no auth). Unlike
Claude's fixed per-component snapshot, this is a flat incident list scoped to all of Google
Cloud. Filter to incidents that are (a) currently open (no `end` timestamp, or `status_impact`
indicating active disruption) and (b) whose `affected_products[].title` matches a Gemini/
Vertex-AI-related fragment (`["Gemini", "Vertex AI", "Generative AI"]` — mirroring the existing
`RELEVANT_COMPONENT_NAME_FRAGMENTS` fragment-match pattern in `claude.ts`, adapted to the
different field name). No matching open incident → `up` (there's no "operational" component
entry to positively confirm, only the absence of a reported problem — this is the correct
reading of an incidents-only feed, and matches how an operator would read the dashboard
themselves). A matching incident's `severity` maps to `degraded`/`down` the same way Claude's
`INDICATOR_RANK` maps StatusPage indicators — `severity: "medium"` → `degraded`, `severity:
"high"`/status_impact indicating full outage → `down`.

**Wiring (`hdl-gs-03`)**: add `geminiAdapters(): ProviderAdapters` to `lane-pipeline.ts`
(mirrors `claudeAdapters`/`codexAdapters` exactly), add one line to `PROVIDER_ADAPTERS` in
`main.ts`. Add one `main.test.ts`-style end-to-end case proving a Gemini lane gets a real
`LanePipeline` + schedulers wired up (mirroring the existing "unknown provider is skipped
gracefully" test's inverse — a *known* provider, `gemini`, should now get pipelines).

## 3. Resolved open questions

1. **Should `public-status` be skipped for Gemini given the feed isn't component-scoped?**
   No — the incidents.json feed is real, free, unauthenticated, and does surface genuine
   Gemini-specific incidents (confirmed via the 2026-02-27 outage). Skipping the layer would
   silently degrade Gemini lanes to passive+active-probe only, which is a worse signal model
   than Claude/Codex get for no real reason. Implement it with the fragment-filter adaptation
   above.
2. **How to represent the missing `reset_at` for 429s?** `null`, always, for Gemini specifically
   — already a supported, tested fallback path in the scheduler. Documented in code comments
   the same way `claude.ts`/`codex.ts` document their own sourcing, so a future contributor
   doesn't mistake the `null` for an oversight.
3. **Header vs query-param auth for the probe?** Header (`x-goog-api-key`) — avoids leaking the
   credential into URLs/logs, consistent with Claude's `x-api-key` header pattern.

## 4. Risks

| Risk | Mitigation |
|---|---|
| `status.cloud.google.com/incidents.json` schema drift (undocumented, unofficial-feeling feed) | Same defensive-default posture as `claude.ts`'s `mapIndicatorToSignal` — unrecognized severity values map to `degraded`, never silently `up`. Fetch failure → `degraded` with reason, matching `claude.ts`. |
| Gemini's 429 body-parsing (`error.status`) is looser than Claude's typed headers — a shape we haven't verified against a *live* 429 (no test account with exhausted quota) | Unit tests use hand-built fixture bodies from the documented shape; note in the story as an accepted verification gap, same class of gap `hdl-actuation`'s DEC doc already accepted for live Multica calls. |
| Fragment-matching against `affected_products[].title` could over- or under-match | Keep the fragment list narrow and documented (`["Gemini", "Vertex AI", "Generative AI"]`) so a false match is traceable and easy to tune later — exactly `claude.ts`'s existing tradeoff, not a new risk class. |

## 5. Scale assessment

**Small.** Three independently-testable files added to an already-proven pattern (2 adapters +
1 wiring change), zero changes to shared/provider-agnostic code, zero new HTTP/MCP/UI surface.
Proceeding directly to stories.

## 6. Dependencies

None outside this codebase — no new npm packages (both adapters use the existing global
`fetch`, matching `claude.ts`/`codex.ts`).
