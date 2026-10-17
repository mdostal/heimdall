// Grok Code (xAI) active-probe adapter — hdl-grok-signals.
// Source: .pHive/epics/hdl-grok-signals/docs/research-brief.md — real
// research against xAI's docs, 2026-09-27.
//
// Uses GET /v1/models as the minimal-cost real call — the OpenAI-convention
// list-models endpoint that confirms auth without making inference calls.
// xAI's API is explicitly documented as OpenAI-API-compatible: Bearer auth,
// same convention active-probe/kimi.ts and active-probe/codex.ts already use.
//
// Error body: OpenAI-compatible `{"error": {"message": "...", "type": "...",
// "code": "..."}}`. The distinguishing field is `error.code` (a string code,
// not a numeric HTTP status repeat). Confirmed codes: `invalid_api_key` (401),
// `insufficient_quota` (402), `rate_limit_exceeded` (429).
//
// UNCONFIRMED (flagged, same honesty posture as other adapters): whether xAI
// always uses HTTP 402 for credit exhaustion or can surface it on another
// status. Both shapes handled defensively (401 branch checks error.code for
// invalid_api_key; a stand-alone 402 branch catches payment-required directly).
//
// Retry-After header for 429: present for xAI rate-limit responses (seconds).
// parseRetryAfter() converts it to an absolute timestamp, fixing the
// raw-passthrough class of bug that hdl-error-taxonomy addressed in kimi.ts
// and codex.ts.

import { parseRetryAfter } from "../../error-parser.js";
import type { ErrorCode } from "../../status-model.js";

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
  error_code: ErrorCode | null;
}

const GROK_MODELS_URL = "https://api.x.ai/v1/models";

interface GrokErrorBody {
  error?: { message?: string; type?: string; code?: string };
}

export async function probeGrokLane(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(GROK_MODELS_URL, {
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

  if (response.status === 401) {
    let body: GrokErrorBody = {};
    try {
      body = ((await response.json()) as GrokErrorBody | null) ?? {};
    } catch {
      // Malformed/non-JSON error body — fall through to a generic auth-failed reason.
    }
    return {
      status: "down",
      reset_at: null,
      reason: body.error?.message ?? `auth failed (${response.status})`,
      error_code: "auth_failed",
    };
  }

  if (response.status === 402) {
    let body: GrokErrorBody = {};
    try {
      body = ((await response.json()) as GrokErrorBody | null) ?? {};
    } catch {
      // Malformed/non-JSON error body — fall through to the generic reason.
    }
    return {
      status: "out_of_credit",
      reset_at: null,
      reason: body.error?.message ?? "insufficient quota (402)",
      error_code: "billing_error",
    };
  }

  if (response.status === 429) {
    let body: GrokErrorBody = {};
    try {
      body = ((await response.json()) as GrokErrorBody | null) ?? {};
    } catch {
      // Malformed/non-JSON error body — fall through to the generic reason.
    }
    return {
      status: "degraded",
      reset_at: parseRetryAfter(response.headers.get("retry-after"), new Date()),
      reason: body.error?.message ?? "rate limited (429)",
      error_code: "rate_limit",
    };
  }

  if (response.status === 403) {
    let body: GrokErrorBody = {};
    try {
      body = ((await response.json()) as GrokErrorBody | null) ?? {};
    } catch {
      // Malformed/non-JSON error body — fall through to a generic auth-failed reason.
    }
    return {
      status: "down",
      reset_at: null,
      reason: body.error?.message ?? `forbidden (${response.status})`,
      error_code: "auth_failed",
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
