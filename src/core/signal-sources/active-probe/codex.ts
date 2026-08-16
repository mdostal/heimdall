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

import { parseRetryAfter } from "../../error-parser.js";
import type { ErrorCode } from "../../status-model.js";

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

export async function probeCodexLane(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
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
    const resetAt = parseRetryAfter(response.headers.get("retry-after"), new Date());

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
