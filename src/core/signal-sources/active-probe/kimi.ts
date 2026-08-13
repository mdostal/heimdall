// Kimi K3 (Moonshot AI) active-probe adapter — REQ-03 (hdl-ks-01).
// Source: .pHive/epics/hdl-kimi-signals/docs/research-brief.md — real web
// research against Moonshot's/Kimi's platform docs, 2026-08-13.
//
// Uses GET /v1/models as the minimal-cost real call (parallel to Claude's/
// Codex's/Gemini's adapters). Moonshot's completions API is OpenAI-API-
// compatible — Bearer auth, same convention active-probe/codex.ts already
// uses. UNCONFIRMED (flagged for refinement, same honesty posture as
// codex.ts's own file-header note): no example curl for this specific
// list-models endpoint was found, only the general host/auth convention
// Moonshot advertises as OpenAI-compatible — treated as a reasonable
// default.
//
// error.type vocabulary (documented for Moonshot's "Kimi Code" product,
// treated as the best available signal for the shared platform error
// taxonomy — see research-brief.md) distinguishes transient conditions
// (engine_overloaded, too_many_requests) from longer-lived quota exhaustion
// (billing_quota_exhausted, monthly_quota_exhausted, rolling_quota_exceeded).
//
// reset_at passes the raw retry-after header value straight through with NO
// relative-to-absolute conversion — mirroring codex.ts's own already-
// accepted simplification for the identical header shape, not a new gap
// introduced here.

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
}

const KIMI_MODELS_URL = "https://api.moonshot.ai/v1/models";

const OUT_OF_CREDIT_ERROR_TYPES = new Set([
  "billing_quota_exhausted",
  "monthly_quota_exhausted",
  "rolling_quota_exceeded",
]);

const AUTH_ERROR_TYPES = new Set(["invalid_api_key", "invalid_authentication"]);

interface KimiErrorBody {
  error?: { type?: string; message?: string };
}

export async function probeKimiLane(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(KIMI_MODELS_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    return {
      status: "down",
      reset_at: null,
      reason: `probe request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (response.status === 401) {
    let body: KimiErrorBody = {};
    try {
      body = (await response.json()) as KimiErrorBody;
    } catch {
      // Malformed/non-JSON error body — fall through to a generic auth-failed reason.
    }
    return {
      status: "down",
      reset_at: null,
      reason: body.error?.message ?? `auth failed (${response.status})`,
    };
  }

  if (response.status === 429 || response.status === 403) {
    let body: KimiErrorBody = {};
    try {
      body = (await response.json()) as KimiErrorBody;
    } catch {
      // Malformed/non-JSON error body — fall through to the degraded default.
    }
    const type = body.error?.type ?? "";
    if (AUTH_ERROR_TYPES.has(type)) {
      return { status: "down", reset_at: null, reason: body.error?.message ?? "auth failed" };
    }
    if (OUT_OF_CREDIT_ERROR_TYPES.has(type)) {
      return {
        status: "out_of_credit",
        reset_at: null,
        reason: body.error?.message ?? "quota exceeded",
      };
    }
    return {
      status: "degraded",
      reset_at: response.headers.get("retry-after"),
      reason: body.error?.message ?? `rate limited (${response.status})`,
    };
  }

  if (response.status >= 500) {
    return { status: "down", reset_at: null, reason: `server error (${response.status})` };
  }

  if (response.ok) {
    return { status: "up", reset_at: null, reason: null };
  }

  return { status: "degraded", reset_at: null, reason: `unexpected status ${response.status}` };
}
