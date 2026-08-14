# Design Discussion — hdl-model-catalog (slice 1)

## 0. Prelude

Corrects an earlier proposal (a git-tracked catalog file) after the operator pointed out
Heimdall's real distribution model — OSS, installed independently by many operators, each
with their own provider access. See research-brief.md for the full correction record.

**Scope of this epic (slice 1 of 3)**: live-fetch + local storage + defaults + query
surface. Dashboard UI (slice 2) and auto-substituting routing (slice 3) are explicitly
deferred, not built here — this slice makes both possible without redoing the foundation.

## 1. Goal

Heimdall can answer, per operator installation, using that operator's own live credentials:
"what models can I actually call right now, per provider, and which ones are currently
enabled for use" — with a sane "newest models only" default applied automatically when a
provider's credential is first configured, freely overridable by the operator.

## 2. Proposed approach

**`state-store.ts`** — new `model_catalog` table:
```sql
CREATE TABLE IF NOT EXISTS model_catalog (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,        -- 0/1 — operator-controlled after first-seen default
  provider_created_at TEXT,        -- nullable — the provider's own recency field, when it has one
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, model_id)
);
```
Same file, same defensive-migration posture as every other table here. `enabled` is the
operator-facing toggle; `last_seen_at` is what lets a later slice detect "this model
disappeared from the live catalog" (its `last_seen_at` stops advancing on refresh).

**`signal-sources/model-list/*.ts`** (new directory, parallel to `active-probe`/
`public-status`) — one function per gated provider (`claude`, `codex`, `kimi`, `gemini`),
each hitting the exact same list-models endpoint its `active-probe` sibling already calls,
but returning the raw model list instead of a liveness verdict:
```ts
export interface RawModelEntry { id: string; createdAt: string | null; }
export async function listClaudeModels(credential: string, fetchImpl?: typeof fetch): Promise<RawModelEntry[]>
```
Kept separate from the probe functions rather than reusing their response — probe calls run
on a health-polling cadence; catalog refresh is a different, much coarser cadence (this
epic's stories don't wire automatic refresh scheduling yet — `refreshModelCatalog` is
callable on-demand via the HTTP/MCP surface this slice adds; scheduling it automatically is
explicitly left to a later slice alongside auto-substitution, since both are "what happens
over time," not "what's the shape of the data").

**`core/model-recency.ts`** (new) — the per-provider default-enable heuristic from
research-brief.md's table: sort-by-`createdAt`-desc for Claude/Codex/Kimi (when the field is
present — Kimi's is unconfirmed live, falls back to "enable everything" if absent, never
silently guessing), a small documented regex-based generation extractor for Gemini
(`gemini-(\d+(?:\.\d+)?)`, highest wins, `-preview`/`-latest` suffix as a same-generation
tiebreak). "Newest ones" is deliberately a small top-N (not just the single latest) — an
operator with `HEIMDALL_LANE_N_MODEL=claude-opus-5` set explicitly should still find that
model enabled by default, not just Anthropic's single newest release.

**`core/model-catalog.ts`** (new) — orchestration: `refreshModelCatalog(store, registry,
fetchImpl?)` iterates every declared lane with a resolved credential and a gated provider,
calls that provider's `list*Models`, diffs against `model_catalog`, applies the recency
default for genuinely-new `(provider, model_id)` pairs (`enabled` defaults per the
heuristic), updates `last_seen_at` for ones still present, leaves existing operator
`enabled` choices untouched (never overwritten by a refresh). `getModelCatalog(store,
provider?)` / `setModelEnabled(store, provider, modelId, enabled)` are the read/write query
functions the HTTP and MCP surfaces both call — mirrors `getLaneStatuses`/
`setLaneOverride`'s shared-function role exactly.

**HTTP** — `GET /models` (optional `?provider=` filter) returns the catalog with `enabled`
state; `POST /models/refresh` triggers `refreshModelCatalog` on demand; `POST
/models/:provider/:modelId` (`{enabled: boolean}`) toggles one entry. **MCP** —
`heimdall.models.list`, `heimdall.models.refresh`, `heimdall.models.setEnabled` — same
three operations, same shared functions, mirroring every prior MCP-tool epic's pattern
exactly.

## 3. Resolved open questions

1. **Auto-refresh scheduling in this slice?** No — `refreshModelCatalog` is callable
   on-demand (HTTP/MCP) in this slice. Wiring it into `InProcessScheduler`/a periodic tick
   is deferred alongside slice 3's auto-substitution — they're the same "over time" concern,
   better designed together once the query surface itself is proven.
2. **What "newest ones" means precisely?** A top-N per provider (not just N=1), chosen so an
   operator's own explicitly-declared `HEIMDALL_LANE_N_MODEL` is very likely to land inside
   the default-enabled set — avoids a surprising "your configured model isn't in the
   default catalog" gap on first boot.
3. **OpenRouter/Ollama in the gated-provider set?** No — see research-brief.md's scoping
   note; both have a real, different reason gating doesn't apply to them, not an oversight.

## 4. Risks

| Risk | Mitigation |
|---|---|
| Kimi's `created` field presence is unconfirmed live (docs claim OpenAI-compatibility, not directly verified against a real response in research) | Defensive: absent/malformed `created` falls back to "enable everything for this provider" rather than silently enabling zero models or guessing wrong. |
| Gemini's generation-extraction regex could misparse a future naming convention change | Same accepted-drift risk class as every other provider-format assumption in this codebase; unparseable entries default to enabled (safe-open, not silently hidden) with a logged note. |
| A refresh could overwrite an operator's deliberate "I turned this off" choice | Explicitly designed not to — `enabled` is only ever set by the recency default on a GENUINELY new `(provider, model_id)` pair; an already-seen pair's `enabled` is never touched by refresh, only `last_seen_at`. |

## 5. Scale assessment

**Medium.** New StateStore table, four new list-models functions (one per gated provider),
one orchestration module, one recency-heuristic module, HTTP + MCP surfaces. No UI, no
routing-selection changes, no scheduler wiring — those are slices 2 and 3. Proceeding to
stories without full H/V — every story mirrors an established pattern from this session
(shared-function + HTTP/MCP dual-surface, `settings`-table-style local persistence,
provider-adapter-shaped list-models calls) even though the surface area is real.
