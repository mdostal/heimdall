// Codex active-probe adapter — REQ-03.
//
// HONESTY NOTE (per signal-inventory.md): the spike confirmed Codex CLI's
// usage-limit message ("You've hit your usage limit ... try again at
// [date/time]") is free text in a CLI-surfaced string, NOT a structured HTTP
// response field — that finding applies to the `codex` CLI's own output, a
// different surface than the raw OpenAI Platform API this adapter probes via
// HTTP (mirroring lhs-03c's Claude pattern for architectural consistency).
//
// hdl-error-taxonomy (2026-08-16): real research against
// platform.openai.com's official docs confirmed OpenAI's 429 error body
// distinguishes cause via `error.type`/`error.code` — real documented codes
// beyond generic rate limiting: `organization_usage_limit_exceeded`,
// `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`
// (usage/spend caps — a longer-window quota, not a payment problem),
// `credit_balance_exhausted`/`insufficient_quota` (genuine billing/payment
// issue). Also confirmed: the real reset-timer signal is the `retry-after`
// header (seconds) — CONFIRMED BUG FIXED HERE: this adapter was passing that
// raw string straight through as reset_at with no conversion
// (Date.parse("30") === NaN, silently discarded by the scheduler). The
// richer duration-string headers (x-ratelimit-reset-requests etc., format
// "6m0s") are NOT parsed here — retry-after alone is sufficient for a
// correct absolute timestamp and is guaranteed present on 429s per OpenAI's
// docs; the duration-string headers are a documented future enhancement for
// remaining/limit display, not needed for the reset_at timer itself.
//
// Uses GET /v1/models as the minimal-cost real call (parallel to Claude's
// adapter) — lightweight, authenticated, no completion tokens spent.
//
// PANT-694: that HTTP path only works for an OpenAI Platform API key. A
// ChatGPT-login (Codex CLI) OAuth access token is a different credential
// namespace — api.openai.com answered a real, valid one with 403 "Missing
// scopes: api.model.read" (2026-09-25). Same root cause as Claude's
// subscription tokens (heimdall#94 / pantheon-v2#210), so the same fix
// applies: shell out to the real `codex` CLI instead of calling the API as
// if the token were an API key. See probeCodexChatGptLane below for the
// credential shape it needs and why.

import { parseRetryAfter, parseTryAgainAtResetTime } from "../../error-parser.js";
import { NodeCommandRunner, type CommandRunner } from "../../scheduler/command-runner.js";
import type { ErrorCode } from "../../status-model.js";
import { CodexHomeStore } from "./codex-home.js";

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
  error_code: ErrorCode | null;
}

const CODEX_MODELS_URL = "https://api.openai.com/v1/models";

interface OpenAiErrorBody {
  error?: { code?: string; type?: string; message?: string };
}

// Genuine billing/payment problem — won't self-heal without a top-up.
const BILLING_CODE_PATTERN = /insufficient_quota|credit_balance_exhausted/i;
// A usage/spend cap the org or project set — a longer-window quota, not a
// payment failure, but equally "won't self-heal until the window resets".
const QUOTA_CODE_PATTERN = /usage_limit|spend_limit/i;

// A bare JWT: a ChatGPT OAuth access token on its own, not a Platform key.
const BARE_JWT_PATTERN = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/;

let defaultHomeStore: CodexHomeStore | null = null;

export async function probeCodexLane(
  credential: string,
  fetchImpl: typeof fetch = fetch,
  commandRunner: CommandRunner = new NodeCommandRunner(),
  homeStore: CodexHomeStore = (defaultHomeStore ??= new CodexHomeStore()),
): Promise<ProbeResult> {
  const trimmed = credential.trim();
  if (trimmed.startsWith("{")) {
    return probeCodexChatGptLane(trimmed, commandRunner, homeStore);
  }
  if (BARE_JWT_PATTERN.test(trimmed)) {
    // The CLI can't run on an access token alone (it needs the id_token and a
    // refresh_token beside it — confirmed live), and the Platform API rejects
    // it, so there is nothing honest to probe with. No network call.
    return {
      status: "down",
      reset_at: null,
      reason:
        "codex credential is a bare ChatGPT access token — provision Heimdall's own `codex login` auth.json instead (see docs/configuration.md)",
      error_code: "auth_failed",
    };
  }
  return probeCodexApiKeyLane(trimmed, fetchImpl);
}

// The smallest real completion the CLI will make. Like Claude's subscription
// probe this spends a little genuine inference: `codex login status` and
// `codex debug models` both reported success for a fabricated token
// (confirmed live, codex-cli 0.157.1), so neither is a liveness check.
const CHATGPT_PROBE_PROMPT = "reply with the single word OK";

interface CodexAuthFile {
  tokens?: { id_token?: unknown; access_token?: unknown; refresh_token?: unknown };
}

function missingAuthField(seed: string): string | null {
  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(seed) as CodexAuthFile;
  } catch {
    return "it is not valid JSON";
  }
  for (const field of ["id_token", "access_token", "refresh_token"] as const) {
    const value = parsed.tokens?.[field];
    if (typeof value !== "string" || value.length === 0) return `tokens.${field} is missing`;
  }
  return null;
}

// credential = the full auth.json of a `codex login` made FOR Heimdall (its
// own session, never a copy of another runtime's). CodexHomeStore writes it
// once into a private CODEX_HOME and leaves every later refresh to the CLI —
// see codex-home.ts for why that is what keeps the probe from racing
// Multica's own codex session over a single-use refresh token.
export async function probeCodexChatGptLane(
  seedAuthJson: string,
  commandRunner: CommandRunner,
  homeStore: CodexHomeStore,
): Promise<ProbeResult> {
  const problem = missingAuthField(seedAuthJson);
  if (problem) {
    return {
      status: "down",
      reset_at: null,
      reason: `codex credential is not a usable auth.json: ${problem}`,
      error_code: "auth_failed",
    };
  }

  return homeStore.withHome(seedAuthJson, async ({ home, workdir }) => {
    let stdout: string;
    try {
      ({ stdout } = await commandRunner.run(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--ignore-user-config",
          "--sandbox",
          "read-only",
          "-C",
          workdir,
          CHATGPT_PROBE_PROMPT,
        ],
        { env: { CODEX_HOME: home } },
      ));
    } catch (err) {
      return interpretCodexCliFailure(err, new Date());
    }
    // A reply is the proof: an exit 0 with nothing on stdout isn't one.
    if (stdout.trim().length === 0) {
      return { status: "degraded", reset_at: null, reason: "codex CLI exited 0 with no reply", error_code: "unknown" };
    }
    return { status: "up", reset_at: null, reason: null, error_code: null };
  });
}

const USAGE_LIMIT_PATTERN = /usage limit/i;
// "refresh token was already used" (a shared session), invalid_refresh_token
// (revoked/rotated away) — the session itself is dead, whichever it was.
const REFRESH_FAILURE_PATTERN = /refresh token|refresh_token/i;
const AUTH_FAILURE_PATTERN = /\b401\b|unauthorized|sign(?:ing)? in again|not logged in/i;
const RATE_LIMIT_PATTERN = /\b429\b|rate limit/i;

function cliOutput(err: unknown): string {
  const e = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [e.stderr, e.stdout, e.message].filter((part): part is string => typeof part === "string").join("\n");
}

// The CLI prints a lot (reconnect retries, sandbox warnings); the reason keeps
// only the first line that explains the verdict, without its log prefix.
function firstMatchingLine(output: string, pattern: RegExp): string {
  const line = output.split("\n").find((l) => pattern.test(l)) ?? output;
  return line
    .replace(/^\S+Z\s+ERROR\s+\S+:\s*/, "")
    .replace(/^ERROR:\s*/, "")
    .trim()
    .slice(0, 300);
}

export function interpretCodexCliFailure(err: unknown, now: Date): ProbeResult {
  const e = err as { code?: unknown; killed?: unknown };
  if (e.code === "ENOENT") {
    return { status: "down", reset_at: null, reason: "codex CLI is not installed (spawn codex ENOENT)", error_code: "unknown" };
  }
  if (e.killed === true) {
    return { status: "down", reset_at: null, reason: "codex CLI probe timed out", error_code: "network_error" };
  }

  const output = cliOutput(err);
  if (USAGE_LIMIT_PATTERN.test(output)) {
    const reason = firstMatchingLine(output, USAGE_LIMIT_PATTERN);
    return {
      status: "out_of_credit",
      reset_at: parseTryAgainAtResetTime(reason, now),
      reason,
      error_code: "quota_exceeded",
    };
  }
  if (REFRESH_FAILURE_PATTERN.test(output)) {
    return {
      status: "down",
      reset_at: null,
      reason: `codex session refresh failed — re-provision Heimdall's own codex login: ${firstMatchingLine(output, REFRESH_FAILURE_PATTERN)}`,
      error_code: "auth_failed",
    };
  }
  if (AUTH_FAILURE_PATTERN.test(output)) {
    return {
      status: "down",
      reset_at: null,
      reason: `codex CLI auth check failed: ${firstMatchingLine(output, AUTH_FAILURE_PATTERN)}`,
      error_code: "auth_failed",
    };
  }
  if (RATE_LIMIT_PATTERN.test(output)) {
    return { status: "degraded", reset_at: null, reason: firstMatchingLine(output, RATE_LIMIT_PATTERN), error_code: "rate_limit" };
  }
  return {
    status: "down",
    reset_at: null,
    reason: `codex CLI probe failed: ${firstMatchingLine(output, /^ERROR:/)}`,
    error_code: "unknown",
  };
}

async function probeCodexApiKeyLane(apiKey: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(CODEX_MODELS_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    return {
      status: "down",
      reset_at: null,
      reason: `probe request failed: ${err instanceof Error ? err.message : String(err)}`,
      error_code: "network_error",
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { status: "down", reset_at: null, reason: `auth failed (${response.status})`, error_code: "auth_failed" };
  }

  if (response.status === 429) {
    // OpenAI does not use a distinct HTTP status for billing/quota failures
    // the way Anthropic's 402 does — both rate-limiting and insufficient
    // quota surface as 429, distinguished by the error body's code/type.
    let body: OpenAiErrorBody = {};
    try {
      body = (await response.json()) as OpenAiErrorBody;
    } catch {
      // Malformed/non-JSON error body — fall through to the rate-limit default.
    }
    const code = body.error?.code ?? body.error?.type ?? "";
    const now = new Date();
    // retry-after is authoritative; without it, fall back to the reset time
    // Codex's usage-limit message states in free text ("try again at ...").
    const resetAt =
      parseRetryAfter(response.headers.get("retry-after"), now) ??
      parseTryAgainAtResetTime(body.error?.message ?? "", now);

    if (BILLING_CODE_PATTERN.test(code)) {
      return { status: "out_of_credit", reset_at: resetAt, reason: body.error?.message ?? "insufficient quota", error_code: "billing_error" };
    }
    if (QUOTA_CODE_PATTERN.test(code)) {
      return { status: "out_of_credit", reset_at: resetAt, reason: body.error?.message ?? "usage/spend limit exceeded", error_code: "quota_exceeded" };
    }
    return {
      status: "degraded",
      reset_at: resetAt,
      reason: body.error?.message ?? "rate limited (429)",
      error_code: "rate_limit",
    };
  }

  if (response.status >= 500) {
    return { status: "down", reset_at: null, reason: `server error (${response.status})`, error_code: "server_error" };
  }

  if (response.ok) {
    return { status: "up", reset_at: null, reason: null, error_code: null };
  }

  return { status: "degraded", reset_at: null, reason: `unexpected status ${response.status}`, error_code: "unknown" };
}
