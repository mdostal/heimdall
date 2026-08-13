// Claude active-probe adapter — REQ-03 (hdl-csl-02 adds subscription-token
// support).
// Source: .pHive/epics/lane-health-status/docs/signal-inventory.md (lhs-00
// spike) — 402 = billing_error, 429 = rate_limit_error with structured
// anthropic-ratelimit-*-reset headers carrying an absolute reset timestamp.
//
// Uses GET /v1/models as the "minimal-cost real call" — it's an
// authenticated, lightweight list endpoint that proves the credential and
// the API are actually reachable without spending on a completion. Never
// just `--version` (PRD REQ-03's explicit requirement).
//
// hdl-csl-02: provider:"claude" lanes now support TWO credential shapes,
// auto-detected — a raw Anthropic API key (the original path below) and a
// Claude Code long-lived OAuth token (sk-ant-oat01-..., from
// `claude setup-token`). Anthropic's Messages API explicitly rejects the
// latter outside the genuine Claude Code client ("OAuth authentication is
// currently not supported") — confirmed via research, not assumed — so the
// correct, sanctioned integration path is shelling out to the real `claude`
// CLI itself, never spoofing the API directly. See
// .pHive/epics/hdl-claude-subscription-lanes/docs/research-brief.md — and
// its correction note below (probeClaudeSubscriptionLane) on which CLI
// subcommand actually validates the token vs. which one merely inspects it.

import { NodeCommandRunner, type CommandRunner } from "../../scheduler/command-runner.js";

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
}

const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION = "2023-06-01";
const SUBSCRIPTION_TOKEN_PREFIX = "sk-ant-oat01-";

export async function probeClaudeLane(
  credential: string,
  fetchImpl: typeof fetch = fetch,
  commandRunner: CommandRunner = new NodeCommandRunner(),
): Promise<ProbeResult> {
  if (credential.startsWith(SUBSCRIPTION_TOKEN_PREFIX)) {
    return probeClaudeSubscriptionLane(credential, commandRunner);
  }
  return probeClaudeApiKeyLane(credential, fetchImpl);
}

// hdl-csl-02 CORRECTION (found via live adversarial testing, 2026-08-13):
// `claude auth status --json` is NOT a real liveness check — it reports
// loggedIn:true for a syntactically-shaped but entirely fabricated token,
// even in a fully isolated HOME with no keychain/cache to fall back to. It
// only checks the token's local shape, never validates it against
// Anthropic's servers. Confirmed instead: a real minimal completion call
// (`claude -p "..." --max-turns 1`) correctly rejects an invalid token
// ("Failed to authenticate. API Error: 401 OAuth access token is invalid.",
// non-zero exit) and correctly succeeds for a genuine token — verified live
// against both a fabricated token and a real long-lived token, in both an
// isolated environment AND a normal one with a separate real login already
// present (ruling out keychain fallback masking the result either way).
//
// UNLIKE every other adapter's free list-models-style check, this ONE real
// call costs a small amount of genuine inference — there is no free
// equivalent for validating a Claude Code OAuth token's liveness. Kept to
// the smallest reasonable prompt + --max-turns 1 (no tool use, no
// multi-turn loop) to minimize that cost, but it is not zero. Documented as
// an accepted, real tradeoff — see design-discussion.md's follow-up note on
// probe-frequency tuning for subscription lanes specifically.
const SUBSCRIPTION_PROBE_PROMPT = "reply with the single word OK";

// execFile (via CommandRunner) rejects on a non-zero exit code — the CLI's
// own exit code IS the liveness signal here; no stdout parsing needed for
// either outcome.
export async function probeClaudeSubscriptionLane(
  credential: string,
  commandRunner: CommandRunner,
): Promise<ProbeResult> {
  try {
    await commandRunner.run("claude", ["-p", SUBSCRIPTION_PROBE_PROMPT, "--max-turns", "1"], {
      env: { CLAUDE_CODE_OAUTH_TOKEN: credential },
    });
  } catch (err) {
    return {
      status: "down",
      reset_at: null,
      reason: `claude CLI auth check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { status: "up", reset_at: null, reason: null };
}

async function probeClaudeApiKeyLane(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_MODELS_URL, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
    });
  } catch (err) {
    // Network-level failure (DNS, connection refused, timeout) — the caller
    // (lhs-03d) decides whether one failure is enough to flag `down`; this
    // adapter just reports what happened, it never throws.
    return {
      status: "down",
      reset_at: null,
      reason: `probe request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (response.status === 402) {
    return { status: "out_of_credit", reset_at: null, reason: "billing error (402)" };
  }

  if (response.status === 429) {
    const resetAt = response.headers.get("anthropic-ratelimit-requests-reset");
    return { status: "degraded", reset_at: resetAt, reason: "rate limited (429)" };
  }

  if (response.status === 401 || response.status === 403) {
    return { status: "down", reset_at: null, reason: `auth failed (${response.status})` };
  }

  if (response.status >= 500) {
    return { status: "down", reset_at: null, reason: `server error (${response.status})` };
  }

  if (response.ok) {
    return { status: "up", reset_at: null, reason: null };
  }

  return { status: "degraded", reset_at: null, reason: `unexpected status ${response.status}` };
}
