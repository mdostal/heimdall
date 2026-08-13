# Research Brief — hdl-claude-subscription-lanes

## Operator decision (2026-08-13)

Verbatim: *"heimdall has to be able to do subscriptions and the tokens -- so both have to
be supported and the hive has a long lived token key which i forget what it comes out as
but it is the long lived token from claude token-setup or whatever -- i thought that
started with sk-ant--"*

Confirms: Heimdall's `claude` provider must support **both** credential types — a raw
Anthropic API key (today's only supported shape, `x-api-key` header, pay-per-token) and a
Claude Code long-lived OAuth token (`claude setup-token`, format `sk-ant-oat01-...` — the
user's memory of "starts with sk-ant" is correct, just the fuller prefix is `sk-ant-oat01-`,
distinguishing it from a raw key like `sk-ant-api03-...`).

## Why raw API-key probing doesn't work for this token type

Confirmed via web research (`claude-code-action`'s own docs, multiple community reports):
`CLAUDE_CODE_OAUTH_TOKEN` is scoped specifically to the Claude Code client — Anthropic's
Messages/completions API directly rejects it ("OAuth authentication is currently not
supported") when called the way `active-probe/claude.ts` calls the raw API today
(`x-api-key` header against `api.anthropic.com/v1/models`). This is a deliberate scoping
by Anthropic, not a bug to route around by spoofing headers.

## What actually works — and what looked like it worked but didn't

**First candidate, REJECTED after adversarial testing**: `claude auth status --json` looked
like exactly the right tool — a dedicated, lightweight, non-interactive auth-check
subcommand, zero inference cost. It correctly reflected the hive's real token
(`{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}`) — but a
follow-up adversarial test (an entirely fabricated, syntactically-shaped token, run in a
fully isolated `HOME` with no keychain/cache reachable) **also** returned
`loggedIn: true`. This subcommand only inspects the token's local shape — it never actually
validates it against Anthropic's servers. Would have shipped a probe that always reports
"up" regardless of whether the credential is real, expired, or revoked — worse than no
check at all. Caught before merge by deliberately testing the failure case, not just the
success case.

**What actually validates the token — confirmed live, both directions**: a real minimal
completion call.
```
claude -p "reply with the single word OK" --max-turns 1
```
- Fabricated token, isolated environment: `Failed to authenticate. API Error: 401 OAuth
  access token is invalid.` (exit 1).
- Fabricated token, normal environment (a separate real `claude.ai` login present, ruling
  out silent fallback): same 401, same exit 1 — the explicit `CLAUDE_CODE_OAUTH_TOKEN`
  override correctly takes precedence.
- The hive's real long-lived token, and the operator's own real token supplied directly:
  both returned a genuine completion (`OK`, exit 0) in every environment tested.

The CLI's exit code is the liveness signal — `execFile` (via `CommandRunner`) already
rejects on non-zero exit, so no stdout parsing is needed for either outcome.

**Real cost, not zero**: unlike `auth status`, this call spends genuine inference (a tiny
amount — one short reply, `--max-turns 1`, no tool use). There is no free way to validate
a Claude Code OAuth token's liveness against Anthropic's servers; this is the one
active-probe in the codebase where "minimal-cost" means "small but non-zero," not "free."

**Gap, honestly accepted**: a completion success/failure reveals login validity only, not
fine-grained usage/rate-limit state — no `degraded`/`out_of_credit` signal available from
this check alone. Same "no path" honesty already established for Ollama's liveness-only
adapter — up/down only for this credential type, not a full severity ladder.

**New runtime dependency, worth noting**: subscription-token lanes require the `claude` CLI
binary to be present and on `PATH` wherever Heimdall runs. Pure API-key lanes have no such
dependency (plain HTTP). This matters for Heimdall's containerized deployment
(`pantheon-v2`'s `Dockerfile.heimdall`, from the `containerize-heimdall` epic) — a container
image without the `claude` CLI installed would correctly report subscription-token lanes as
`down` (exec failure → down, never a crash), not silently mis-detect them as API-key lanes.

## Codebase precedent for subprocess-based signal sources

`CommandRunner` (`src/core/scheduler/command-runner.ts`) already exists for exactly this
class of dependency — `MulticaAutopilotScheduler` shells out to the real `multica` CLI
through it, never `node:child_process` directly, so tests never touch a real daemon. It
does not currently support passing custom environment variables to the subprocess
(`run(command, args)` — no `env` override), which the subscription-token probe needs
(`CLAUDE_CODE_OAUTH_TOKEN` must be set for that one call, not the whole Heimdall process).
A small, backward-compatible extension (`run(command, args, options?: { env?: ... })`)
covers this.

## Design: auto-detect by credential shape, no new provider/config surface

`provider: "claude"` stays singular — the same value covers both credential types, matching
the north star's own framing ("Claude, Codex... 2-5 Claude Code subscriptions" alongside
plain API-key lanes, never described as separate providers). `probeClaudeLane` inspects the
credential string itself: `sk-ant-oat01-` prefix → subprocess/CLI path;
anything else → today's existing HTTP path, unchanged. Zero new operator-facing
configuration — an operator just pastes whichever kind of token they have into the same
`HEIMDALL_LANE_<N>_CREDENTIAL_REF`-pointed env var.

## Sources

- [claude-code-action setup docs](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md) — `CLAUDE_CODE_OAUTH_TOKEN` / `claude setup-token` confirmation.
- Live local testing, 2026-08-13: `claude auth status --json` (rejected — false positive on a fabricated token) and `claude -p "..." --max-turns 1` (confirmed correct) against a fabricated token, the hive's actual long-lived token (fetched over SSH, never displayed in full — only prefix/length checked), and the operator's own real token (supplied directly, never echoed back).
- `src/core/scheduler/command-runner.ts` / `src/core/scheduler/multica-autopilot-scheduler.ts` — the existing subprocess-injection pattern this epic extends.
