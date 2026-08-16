# Design Discussion — hdl-error-taxonomy

## 0. Prelude

Follow-on from `hdl-429-corroboration` (Claude-only). Operator (2026-08-16), in
response: *"we do not just show our status of up, down, intermittent or whatever,
we have FULL error codes and responses and give it back so we can nail out all of
the things and have degraded from -- x and then check or put a timer in for the
time the limit gives back -- we need to build the correct timer checks and
capabilities to make this make sense."*

Two full research/audit passes (real repo reads, no guessing) preceded any code
change: (1) every provider adapter's current reason/reset_at richness and the
whole `reset_at`-as-timer chain end to end, (2) Codex's and OpenRouter's real
error/header shapes against their official docs (Anthropic's was already covered
by `hdl-429-corroboration`).

Design fork (asked via `AskUserQuestion`, not decided unilaterally): native
per-provider error vocabulary vs. a normalized cross-provider taxonomy vs. both.
Operator chose **both** — *"normalize and native detail kept... but at some point
we have to internally know the action to take and OUR state could be one of the 3
but then with full details underneath."*

## 1. Shape

- `LaneStatusValue` (`up`/`down`/`out_of_credit`/`degraded`) is **unchanged** —
  stays the simple, actionable state routing/actuation reason about.
- New `ErrorCode` (`rate_limit | quota_exceeded | billing_error | auth_failed |
  server_error | network_error | unknown`) — the normalized layer, driving what
  internal logic *does* (see §3).
- `reason: string | null` — unchanged, stays the native/raw human-readable detail,
  never discarded in favor of the normalized code.

## 2. Real bugs found and fixed (not just enrichment)

- **Codex + Kimi**: both passed the raw `retry-after` header straight through as
  `reset_at` (a plain seconds string like `"30"`). `Date.parse("30")` is `NaN`;
  `InProcessScheduler` silently fell back to the flat interval. The real retry
  timer was computed correctly by the provider and thrown away by Heimdall. Fixed
  by exporting `parseRetryAfter()` from `error-parser.ts` (already used for
  Claude's cap-signal detection) and reusing it in both adapters.
- **`lane-pipeline.ts`**: `persistResolved()` dropped `reset_at` to `null` on the
  first (uncorroborated) signal tick — a full extra corroboration cycle before the
  real timer value was ever stored, even though it was diagnostic detail, not
  itself an unconfirmed verdict. Fixed: `reset_at`/`error_code` now always flow
  through; only the `status` field stays conservative pending corroboration.
- **OpenRouter**: the 429 branch never read the response body at all (a static
  `"rate limited (429)"` string) and passed `X-RateLimit-Reset` through raw with a
  comment admitting the format was unconfirmed. Research confirmed the format is
  genuinely undocumented by OpenRouter (not just hard to find) — so this adapter
  now honestly reports `reset_at: null` for that case rather than a
  confidently-wrong guess, while still reading the real `error.message`/
  `error.metadata.error_type` the docs did confirm.

## 3. Timer/action-taking

`InProcessScheduler`'s flat ~5s cadence for suspect lanes with an unknown
`reset_at` is load-bearing for the documented, tested 10-second corroboration SLA
(`test/sla-harness`'s own finding — see `hdl-route-outcome-feedback`'s sibling
investigation into probe-cadence tuning, which found the same constraint and
declined to touch it generally). This epic finds the one **safe** exception:
`auth_failed` cannot self-heal by retrying — no amount of re-probing detects a
credential fixing itself faster; only an operator action does. There is no
self-healing event to risk missing within the SLA window for this class
specifically, so backing it off to a fixed 5-minute recheck is safe where backing
off `rate_limit`/`quota_exceeded`/`server_error`/`network_error` generally would
not be. An operator's explicit `manual_reset_at` still wins outright over this
automatic backoff, matching every other override precedent in this codebase.

## 4. Per-provider mapping (research-grounded, not guessed)

- **Claude**: 402→`billing_error`, 429→`rate_limit`/`quota_exceeded` (via
  `parseClaudeCapSignal`'s existing weekly-limit detection), 401/403→`auth_failed`,
  5xx→`server_error`, network failure→`network_error`.
- **Codex**: real OpenAI error codes confirmed via platform.openai.com —
  `insufficient_quota`/`credit_balance_exhausted`→`billing_error`;
  `organization_usage_limit_exceeded`/`organization_spend_limit_exceeded`/
  `project_spend_limit_exceeded`→`quota_exceeded`; unrecognized 429→`rate_limit`.
- **Kimi**: already had a typed `error.type` vocabulary from `hdl-kimi-signals` —
  mapped directly (`billing_quota_exhausted`/`monthly_quota_exhausted`/
  `rolling_quota_exceeded`→`quota_exceeded`, auth types→`auth_failed`, else
  `rate_limit`).
- **Gemini**: existing quota/daily-limit message detection mapped to
  `quota_exceeded`/`rate_limit`; `reset_at` stays honestly `null` (no such field
  exists, confirmed in `hdl-gemini-signals`).
- **OpenRouter**: 402→`billing_error`, 429→`rate_limit` (using the real
  `error.metadata.error_type`/`error.message` now read), `reset_at` honestly
  `null` (format undocumented — see §2).
- **Ollama**: `network_error`/`unknown` only for its two down cases — no
  rate-limit/quota/billing/auth concept exists for local unauthenticated
  inference, confirmed in `hdl-ollama-signals`.

## 5. Scale assessment

Large — touches `status-model.ts`, `state-store.ts` (schema + migration),
`lane-pipeline.ts`, all 6 provider adapters, `http-server.ts` (automatic via
`LaneStatus` extension), the dashboard, and `InProcessScheduler`. No HTTP/MCP
surface changes needed — `GET /lanes`/MCP `heimdall.lanes.list` already spread the
full `LaneStatus` object.
