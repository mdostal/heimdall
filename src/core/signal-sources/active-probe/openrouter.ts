// OpenRouter active-probe adapter — REQ-03 (hdl-or-01).
// Source: .pHive/epics/hdl-openrouter-signals/docs/research-brief.md — real
// web research against OpenRouter's own docs, 2026-08-13.
//
// Uses GET /api/v1/key as the probe call — an account-level key-introspection
// endpoint, richer than every other adapter's "list models" liveness check:
// one call returns both credit balance (limit_remaining) and rate-limit
// state. Bearer auth, same convention active-probe/codex.ts and kimi.ts
// already use.
//
// hdl-error-taxonomy (2026-08-16): real research against
// openrouter.ai/docs/api_reference/limits confirmed the actual error body
// shape — `{"error": {"code": <http-status-number>, "message": ...,
// "metadata": {"error_type": ..., "provider_code": ...}}}`. `error.code` is
// just the HTTP status repeated, NOT a semantic string — the real
// distinguishing signal is `error.metadata.error_type`, now read and
// surfaced in `reason` (previously the 429 branch didn't read the body at
// all). Confirmed: 402 = credit exhaustion (permanent until top-up), 429 =
// rate limiting (OpenRouter platform cap OR an upstream provider's own cap,
// possibly carrying `error.metadata.provider_code` when passed through) —
// docs explicitly recommend exponential backoff for 429, not a precise
// timer. `X-RateLimit-Reset`'s value FORMAT remains genuinely undocumented
// (confirmed via direct research — OpenRouter's own docs do not specify
// unix seconds vs ms vs anything else) — this adapter deliberately does NOT
// convert or trust that header as a timestamp (the prior code passed it
// through raw, which is no better than not reading it — a confidently-wrong
// guess is worse than an honest null). reset_at stays null for OpenRouter's
// 429 case until an authoritative format is found.
//
// UNCONFIRMED (flagged, same honesty posture as other adapters' own gaps):
// whether GET /api/v1/key itself can return 402 at zero balance, or always
// returns 200 with limit_remaining: 0 — both shapes are handled explicitly
// below rather than guessing which one is real.
//
// No public-status/openrouter.ts exists for this provider — no confirmed
// machine-readable status feed was found (research-brief.md). This adapter's
// unusually rich signal (credit + rate-limit in one call) already exceeds
// what most other providers get from public-status alone.

import type { ErrorCode } from "../../status-model.js";

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
  error_code: ErrorCode | null;
}

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

interface OpenRouterKeyBody {
  data?: { limit?: number | null; limit_remaining?: number | null };
}

interface OpenRouterErrorBody {
  error?: { code?: number; message?: string; metadata?: { error_type?: string; provider_code?: string } };
}

export async function probeOpenRouterLane(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(OPENROUTER_KEY_URL, {
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

  if (response.status === 402) {
    let body: OpenRouterErrorBody = {};
    try {
      body = ((await response.json()) as OpenRouterErrorBody | null) ?? {};
    } catch {
      // Malformed/non-JSON error body — fall through to the generic reason.
    }
    return {
      status: "out_of_credit",
      reset_at: null,
      reason: body.error?.message ?? "insufficient credits (402)",
      error_code: "billing_error",
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { status: "down", reset_at: null, reason: `auth failed (${response.status})`, error_code: "auth_failed" };
  }

  if (response.status === 429) {
    let body: OpenRouterErrorBody = {};
    try {
      body = ((await response.json()) as OpenRouterErrorBody | null) ?? {};
    } catch {
      // Malformed/non-JSON error body — fall through to the generic reason.
    }
    return {
      status: "degraded",
      // See file header — X-RateLimit-Reset's format is genuinely
      // undocumented; deliberately not read/converted here.
      reset_at: null,
      reason: body.error?.message ?? "rate limited (429)",
      error_code: "rate_limit",
    };
  }

  if (response.status >= 500) {
    return { status: "down", reset_at: null, reason: `server error (${response.status})`, error_code: "server_error" };
  }

  if (response.ok) {
    let body: OpenRouterKeyBody = {};
    try {
      body = ((await response.json()) as OpenRouterKeyBody | null) ?? {};
    } catch {
      // Malformed/non-JSON body on an otherwise-2xx response — treat as up
      // rather than guessing at a credit state we can't read.
      return { status: "up", reset_at: null, reason: null, error_code: null };
    }
    const remaining = body.data?.limit_remaining;
    if (typeof remaining === "number" && remaining <= 0) {
      return {
        status: "out_of_credit",
        reset_at: null,
        reason: "limit_remaining reached zero (200 response)",
        error_code: "billing_error",
      };
    }
    return { status: "up", reset_at: null, reason: null, error_code: null };
  }

  return { status: "degraded", reset_at: null, reason: `unexpected status ${response.status}`, error_code: "unknown" };
}
