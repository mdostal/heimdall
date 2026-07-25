# Signal Inventory Spike — Claude + Codex (lhs-00)

Gating spike per PRD REQ-00. Findings below are the evidentiary basis for the
`ProviderSignalAdapter` content built in lhs-03b/lhs-03c (Claude) and lhs-04
(Codex). Confirmed vs. inferred is marked per item — this repo has no live
authenticated provider accounts to probe directly, so CLI/API error-shape
findings are sourced from official docs, changelogs, and public bug reports
rather than a live account.

## Claude (Claude Code / Anthropic API)

### Public status endpoint — CONFIRMED structured
- `https://status.claude.com/api/v2/status.json` and `.../summary.json` — Atlassian
  StatusPage.io-backed, JSON, no auth required, no per-lane token cost.
- Component-level granularity: lists Claude Code, claude.ai, and the API
  (`api.anthropic.com`) as separate components, each with an `indicator`:
  `operational | degraded_performance | partial_outage | major_outage`.
- **Implication for lhs-03b:** map `degraded_performance`/`partial_outage` →
  our `degraded` state, `major_outage` → `down`. Poll the Claude Code /
  API component specifically, not just overall page status — a degraded
  claude.ai web incident shouldn't necessarily flag the API-consuming lane.

### Error codes / rate-limit signal — CONFIRMED structured
- `429` responses: `{"type": "error", "error": {"type": "rate_limit_error", "message": "..."}}`
  plus a `retry-after` header (seconds).
- Three simultaneous limit dimensions, each with its own header set:
  `anthropic-ratelimit-{requests,input-tokens,output-tokens}-{limit,remaining,reset}`.
  `reset` values are absolute timestamps — this is the cleanest possible
  quota-reset signal of anything found in this spike.
- `402` responses: `billing_error` type — confirmed distinct from rate-limit,
  maps directly to our `out_of_credit` state.
- **Implication for lhs-03a (passive) + lhs-03e (resolution):** a 429 response's
  per-dimension `-reset` header is exactly the `reset_at` field our 4-state
  model needs — no parsing ambiguity, these are structured headers, not
  free-text messages.

### Claude Code specific behavior — CONFIRMED (partially), one CAVEAT
- Claude Code enforces a 5-hour rolling window **plus** a weekly cap on active
  compute hours, shared across Claude Code / claude.ai / Cowork usage.
- **CAVEAT (real-world noise source, directly relevant to the north-star's
  "false failures" pain point):** multiple reported cases (e.g.
  anthropics/claude-code#22876) of 429s firing despite the usage dashboard
  showing available quota, across multi-account (Max) setups specifically.
  **Implication:** lhs-03c's active-probe adapter and lhs-03d's escalation
  logic should NOT treat a single 429 as unconditionally authoritative for
  Claude Code lanes — this is exactly the kind of silent/false failure
  Heimdall is meant to guard against, not blindly propagate. Recommend a
  short corroboration window (e.g. one retry after a brief delay) before
  flagging a Claude Code lane `down` from a 429 alone. This is a design
  input for lhs-03d, not a blocker.

## Codex (OpenAI Codex CLI)

### Public status endpoint — CONFIRMED structured
- `https://status.openai.com/api/v2/status.json` and `.../summary.json` — same
  StatusPage.io backend/shape as Anthropic's. No auth, no token cost.
- **Implication for lhs-04:** the public-status adapter pattern from lhs-03b
  generalizes directly — same indicator enum, same mapping to
  degraded/down. This is a good early signal the `ProviderSignalAdapter`
  interface is sound across providers, not just Claude-shaped.

### Error codes / rate-limit signal — CONFIRMED, less structured than Claude
- Codex CLI's usage-limit message is presented as a **human-readable CLI
  string**: "You've hit your usage limit ... try again at [specific date/time]"
  — a reset time IS present, but as free text in a CLI message rather than a
  structured HTTP header. Confirmed via OpenAI community reports and GitHub
  issues (openai/codex #16909, #34865, #29948), not official API docs — no
  official schema found for this message format.
- ChatGPT Plus tier: 5-hour rolling window reset, mirroring Claude Code's
  short-window behavior.
- Underlying OpenAI Platform API (if Codex CLI is ever driven via API key
  rather than ChatGPT-plan auth) — no confirmed distinct error-code
  inventory was found in this spike; treat as **INFERRED/UNKNOWN**, flag for
  a follow-up spike if API-key-mode Codex lanes are added later.
- **Implication for lhs-03c pattern reuse in lhs-04:** the active-probe
  adapter for Codex will need to parse a free-text "try again at ..." string
  for the reset time, not read a header — more brittle than Claude's
  approach. Recommend a defensive parser with a documented fallback (if the
  message format can't be parsed, report `out_of_credit` with `reset_at: null`
  rather than failing).

### Known reliability caveat — CONFIRMED
- Multiple reports (openai/codex #16909, community thread on Pro-account
  false usage-limit errors) of Codex CLI reporting "usage limit reached"
  inconsistently with the actual account dashboard, including for accounts
  with 100% quota remaining. **Same implication as Claude's caveat above:**
  lhs-03d's escalation logic should treat a single Codex usage-limit message
  with the same "don't blindly trust one signal" caution as Claude's 429s.

## Summary table for lhs-03d (staleness/escalation) and lhs-03e (resolution model)

| Signal | Claude | Codex |
|---|---|---|
| Public status format | Structured JSON (StatusPage.io) | Structured JSON (StatusPage.io) — same shape |
| Rate-limit/quota-reset signal | Structured HTTP headers, absolute timestamps | Free-text CLI message, needs parsing, best-effort |
| Payment-failure signal | Structured `402 billing_error` | Not confirmed distinct from usage-limit message — treat as same `out_of_credit` path pending further evidence |
| Known false-positive risk | Yes — 429 despite available quota (multi-account) | Yes — usage-limit reached despite available quota |

**Recommendation carried into lhs-03d:** both providers have a documented
false-positive risk on their most common failure signal. The escalation/
staleness logic should require either (a) a repeated signal within a short
window, or (b) corroboration from the public-status endpoint, before
resolving a lane to `down`/`out_of_credit` from a single active-probe
response alone. This directly serves the north-star's stated pain point
("OAuth and other silent runtime hangs ... produce false failures").
