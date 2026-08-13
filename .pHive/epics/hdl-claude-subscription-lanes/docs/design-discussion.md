# Design Discussion — hdl-claude-subscription-lanes

## 0. Prelude

**NORTH STAR**: `expected_scale` describes "2-5 Claude Code subscriptions" as a real target
shape, distinct from pay-per-token API access — this epic is the first time Heimdall
actually supports that credential type, closing a gap between the product's stated vision
and what `active-probe/claude.ts` has ever done (raw API keys only, since the very first
lane-health-status epic).

**OPERATOR DECISION** (verbatim): *"heimdall has to be able to do subscriptions and the
tokens -- so both have to be supported."*

## 1. Goal

`provider: "claude"` lanes support both a raw Anthropic API key and a Claude Code
long-lived OAuth token (`sk-ant-oat01-...`, from `claude setup-token`), auto-detected by
credential shape — zero new configuration surface.

## 2. Proposed approach

**`command-runner.ts`** — extend `CommandRunner.run()` with an optional third parameter:
`run(command: string, args: string[], options?: { env?: Record<string, string> }):
Promise<CommandResult>`. `NodeCommandRunner` passes `{ ...process.env, ...options.env }` to
`execFile` when provided, else unchanged (today's exact behavior). Backward compatible —
`MulticaAutopilotScheduler`'s existing 2-arg calls are unaffected.

**`active-probe/claude.ts`** — `probeClaudeLane` becomes a thin dispatcher:
```
if (credential.startsWith("sk-ant-oat01-")) return probeClaudeSubscriptionLane(credential, commandRunner);
return probeClaudeApiKeyLane(credential, fetchImpl); // today's existing logic, renamed, unchanged
```
`probeClaudeSubscriptionLane` shells out to `claude auth status --json` with
`CLAUDE_CODE_OAUTH_TOKEN` set to the credential for that one call
(`{ env: { CLAUDE_CODE_OAUTH_TOKEN: credential } }`), parses `{ loggedIn, authMethod }`:
- `loggedIn: true` → `up`, `reason: null`.
- `loggedIn: false` → `down`, `reason: "not logged in (<authMethod>)"`.
- Exec failure (non-zero exit, `claude` CLI not found, malformed JSON) → `down`, never
  throws — same never-throws contract every adapter in this codebase already follows.
- No `degraded`/`out_of_credit` path — `auth status` reveals login validity only, not
  usage/rate-limit state. Honest gap, documented, same class as Ollama's liveness-only
  adapter.

**No changes needed** to `LanePipeline`, `ProviderAdapters`, `main.ts`'s `PROVIDER_ADAPTERS`,
or any HTTP/MCP/UI surface — `probeClaudeLane`'s signature stays
`(credential: string, fetchImpl?: typeof fetch, commandRunner?: CommandRunner):
Promise<ProbeResult>`, and TypeScript's structural typing already permits a function with
an extra optional trailing parameter to satisfy `ProviderAdapters.probe`'s narrower type —
confirmed precedent from every `alwaysUp*PublicStatus` stub already in this codebase.
`LanePipeline` calling `this.adapters.probe(lane.credential, this.deps.fetchImpl)` (2 args)
still works correctly; `commandRunner` defaults to a real `NodeCommandRunner()` in
production, and tests inject a fake one by calling `probeClaudeLane` directly with a third
argument (mirroring how every existing `active-probe/*.test.ts` file already tests probe
functions directly, not through the full pipeline).

## 3. Resolved open questions

1. **Separate provider name for subscription lanes (e.g. `claude-subscription`)?** No —
   auto-detect by credential shape. One `provider: "claude"` value, matching how the north
   star itself never distinguishes "Claude API" from "Claude Code subscription" as separate
   providers — they're the same underlying product, different credential issuance paths.
2. **Should this replicate the OAuth token's internal HTTP request shape instead of
   shelling out to the real CLI?** No — Anthropic's Messages API explicitly rejects direct
   OAuth-token calls outside the genuine Claude Code client; reverse-engineering the
   internal request shape to spoof that identity would be circumventing a deliberate
   provider-side restriction, not a legitimate integration path. Shelling out to the real,
   official `claude` CLI is the correct, sanctioned mechanism — and this codebase already
   has an established, tested pattern for exactly this class of dependency (`CommandRunner`
   / `MulticaAutopilotScheduler`).
3. **Public-status for subscription lanes?** Unchanged — `provider: "claude"` still uses
   the existing `checkClaudePublicStatus` (status.claude.com) regardless of which
   credential shape the active-probe side detects; the public status page reflects
   Anthropic's service health generally, not which auth method a given lane uses.

## 4. Risks

| Risk | Mitigation |
|---|---|
| `claude` CLI not installed/on `PATH` wherever Heimdall runs (containers, CI) | Exec failure (`ENOENT`) is caught and mapped to `down`, never a crash — same defensive posture as every network failure in every other adapter. Documented as a real, accepted runtime dependency specific to subscription-token lanes only. |
| `claude auth status --json`'s output shape could change across CLI versions | Same accepted-drift risk class as any external CLI/API this codebase already depends on (`multica`, every provider's HTTP API); malformed/unrecognized JSON maps to `down`, never a silent `up`. |
| Setting `CLAUDE_CODE_OAUTH_TOKEN` via subprocess env could leak into a shared process env if implemented wrong | `execFile`'s `options.env` fully scopes the variable to that one child process — never touches Heimdall's own `process.env`. Verified via `NodeCommandRunner`'s existing `execFileAsync` usage. |

## 5. Scale assessment

**Small–Medium.** Two files touched (`command-runner.ts`'s small backward-compatible
extension, `active-probe/claude.ts`'s dispatcher split) plus tests. No schema, routing, or
UI changes — proceeding directly to stories.
