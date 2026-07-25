// Claude active-probe adapter — REQ-03.
// Source: .pHive/epics/lane-health-status/docs/signal-inventory.md (lhs-00
// spike) — 402 = billing_error, 429 = rate_limit_error with structured
// anthropic-ratelimit-*-reset headers carrying an absolute reset timestamp.
//
// Uses GET /v1/models as the "minimal-cost real call" — it's an
// authenticated, lightweight list endpoint that proves the credential and
// the API are actually reachable without spending on a completion. Never
// just `--version` (PRD REQ-03's explicit requirement).

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
}

const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION = "2023-06-01";

export async function probeClaudeLane(
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
