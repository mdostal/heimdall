# Research Brief — hdl-backoff-policies

## Requirement

Operator, after reviewing a scoping Artifact (all 4 questions confirmed):
"dig into a solid /plugin-hive:plan and nail that for sure and then we can
execute -- as long as we can tweak and configure and tune it to an
exponential backoff or different policies and heuristics and try or
choose, then it should just be wrapping a backoff provider call and we can
implement more of them as we see fit and try them out -- just do a couple
defaults -- static, increase with a rule and level up to like 10 --
progressive -- then an exponential progressive and say when to stop so put
a limit on it."

Replace the hardcoded probe-cadence backoff logic in `InProcessScheduler`
with a pluggable `BackoffPolicy` architecture, mirroring the existing
`RoutingStrategy` pattern exactly. Ship 3 initial policies (static,
progressive, exponential-progressive), extensible with more later. Also
bring headroom/cost-tier out of env-var-only obscurity into live-editable
per-lane settings.

## Current scheduler internals (`src/core/scheduler/in-process-scheduler.ts`, 184 lines, read in full)

- `computeDelayMs(resetAt, errorCode)` (private method, ~lines 83-100) is
  the exact logic to replace:
  - `errorCode === "auth_failed"` → hardcoded `AUTH_FAILED_BACKOFF_MS = 5 *
    60_000` (fixed 5 min), regardless of anything else.
  - known `resetAt` → wait until reset_at, floored at `this.intervalMs`
    (never below it, never zero/negative from clock skew).
  - otherwise → flat `this.intervalMs` (`DEFAULT_INTERVAL_MS = 5_000`).
- `poll()` (~lines 120-183) tracks **no consecutive-suspect-tick counter at
  all** today — a new stateful `BackoffPolicy` needs new instance state
  (increment while `stillSuspect`, reset to 0 the instant `!stillSuspect`).
  This reset-on-recovery behavior is load-bearing: the file's own header
  comment and `docs/scheduler-constraints.md` both document "backs off
  immediately on recovery" as a guarantee, not an implementation detail.
- `manual_reset_at` (hdl-lm-03) wins outright over BOTH the sensed
  `reset_at` AND any automatic backoff computation — highest precedence in
  the codebase, must not become overridable by the new pluggable policy.
- The 10-second SLA (`test/sla-harness`) already governs the flat 5s
  default for self-healing error classes (`rate_limit`, `quota_exceeded`,
  `server_error`, `network_error`, `unknown`) — a new policy's first-step
  delay for those classes must not silently violate it.
- `auth_failed`'s fixed 5-min backoff has a *safety* rationale ("no
  self-healing event to risk missing — only an operator action fixes a bad
  credential"), not a *preference* rationale. This is the one real design
  fork for /plan: does it stay a hard invariant checked before the
  pluggable policy runs, or become one more input the policy receives?

## Established pluggable-strategy precedent (`src/core/routing-strategies/`, read in full)

Real, working precedent in this exact codebase — mirror this shape exactly,
don't invent a new one:

- `types.ts` — the `RoutingStrategy` interface.
- One file per strategy: `priority-strategy.ts`, `round-robin-strategy.ts`,
  `off-strategy.ts`, `scored-strategy.ts`.
- `registry.ts`'s `createRoutingStrategyRegistry(): Record<string,
  RoutingStrategy>` factory function.
- Settings-table persistence in `src/api/http-server.ts`:
  `ROUTING_STRATEGY_SETTING_KEY` constant, `setRoutingStrategy(store,
  rawName)` / `getActiveRoutingStrategyName(store)` functions, `GET`/`POST
  /routing-strategy` HTTP routes (read in full, lines ~580-610) — GET
  returns `{active, available}`, POST validates and returns a structured
  `{error, allowed_strategies}` on an invalid name rather than throwing.
- Dashboard Settings panel renders a picker from the `available` list
  (`dashboard.ts` line ~1107 onward, theme/icon pickers as the visual
  pattern — button-per-option, `.active` class on the current choice).

## Per-lane operator-override precedent (`src/core/state-store.ts`, read in full)

`manual_override`/`manual_reset_at` are the direct precedent for making
headroom/cost-tier live-editable:

- Added via defensive `ALTER TABLE lanes ADD COLUMN ...` migrations (each
  wrapped in a try/catch that swallows "column already exists" — idempotent
  across repeated startups, same pattern for every prior column addition).
  `manual_override` has a `CHECK` constraint (`IN ('enabled','disabled') OR
  NULL`); `manual_reset_at` and `override_reason` are plain nullable `TEXT`.
- `setManualOverride(laneId, value, reason)` / `getManualOverride(laneId)`,
  `setManualResetAt(laneId, value)` / `getManualResetAt(laneId)` — simple
  `UPDATE`/`SELECT` pairs scoped by `lane_id`.
- Precedence: an operator-set value always wins over the sensed/env-var
  default, applied at read time in the consuming logic (scheduler for
  reset_at, `MulticaControlAdapter`/scored-strategy for override), never by
  mutating the underlying sensed/default value itself.

## Headroom/cost-tier current state (`src/core/lane-registry.ts`, read in full)

- `DEFAULT_HEADROOM = 10000`, `DEFAULT_COST_TIER: LaneCostTier = "medium"`
  (`COST_TIERS = ["low","medium","high"]`).
- Set per-lane via `HEIMDALL_LANE_N_HEADROOM` / `HEIMDALL_LANE_N_COST_TIER`
  env vars, parsed once at process start in `buildLaneRegistry()` — a
  malformed value causes `console.warn` + skips the whole lane (existing,
  ported behavior, not something this epic touches).
- Consumed by `src/core/routing-strategies/scored-strategy.ts`'s
  `headroom_floor` gating (candidates below the policy's floor are
  excluded from consideration).
- **Never surfaced in the dashboard at all today** — an operator can't see
  these values without reading `.env` directly.

## Structured per-item config precedent (`src/core/routing/policy-loader.ts`, read in full)

`Policy`/`PolicyExperiments` is the one existing example of storing
structured (multi-field) configuration in this codebase — but it's loaded
from a YAML file (`config/routing-policy.yaml`) via `PolicyLoader.load()`,
read fresh on every `GET /routing-policy` request, NOT stored in the
`settings` key-value table. This is a different shape than
`routing_strategy`'s simple string-in-settings-table pattern. Real open
question for /plan: policy-specific tunables (progressive's step count,
exponential's multiplier + ceiling) — flat individual settings-table keys,
or a JSON blob under one key? The `settings` table's existing rows are all
simple scalar values (theme name, icon name, strategy name, dismissed
boolean) — no precedent yet for a structured blob in that table.

## Provider-published backoff/SLA research (already done, Phase A of the prior OSS-hardening epic)

- **Claude**: real, **live** `anthropic-ratelimit-*` response headers,
  already parsed by `hdl-429-corroboration` (used to set `reset_at`) but
  never displayed anywhere in the dashboard.
- **OpenRouter**: `X-RateLimit-*` headers parsed for credit balance; the
  reset-timestamp header's *format* is confirmed genuinely undocumented
  (not just unread) — cannot be converted to an absolute timestamp today.
- **Codex, Kimi, Gemini**: only reactive 429 error-body detail (what kind
  of limit was hit); no proactive polling-budget header on a successful
  response.
- **Ollama**: local, unauthenticated — no rate-limit concept applies.
- Realistic scope for "surface known limits" in the settings UI: show
  Claude/OpenRouter's live headers as read-only context next to the
  tunable policy picker; honestly label the rest "not published by
  provider" rather than inventing a number.

## Open questions this research does not resolve (real design work for /plan)

1. Exact `BackoffPolicy` interface shape.
2. Config storage shape for policy-specific tunables (flat settings keys
   vs. JSON blob).
3. How global-policy-selection composes with a per-provider override (full
   policy swap, or parameter override on the global policy?).
4. Whether/how the dashboard frames the 10-second-SLA tradeoff when an
   operator picks an aggressive policy (named-preset framing vs. raw
   values with no framing).
5. Whether `auth_failed`'s fixed backoff stays a hard invariant outside the
   pluggable system.
6. Exact UI design for both the backoff-policy picker and the per-lane
   headroom/cost-tier editable fields.
