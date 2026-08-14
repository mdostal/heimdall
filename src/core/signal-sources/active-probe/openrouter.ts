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
// UNCONFIRMED (flagged, same honesty posture as other adapters' own gaps):
// whether GET /api/v1/key itself can return 402 at zero balance, or always
// returns 200 with limit_remaining: 0 — both shapes are handled explicitly
// below rather than guessing which one is real. The exact format of the
// X-RateLimit-Reset header (unix seconds vs ms vs something else) is also
// unconfirmed — passed through raw as reset_at with no conversion, mirroring
// kimi.ts's identical retry-after situation.
//
// No public-status/openrouter.ts exists for this provider — no confirmed
// machine-readable status feed was found (research-brief.md). This adapter's
// unusually rich signal (credit + rate-limit in one call) already exceeds
// what most other providers get from public-status alone.

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
}

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

interface OpenRouterKeyBody {
  data?: { limit?: number | null; limit_remaining?: number | null };
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
    };
  }

  if (response.status === 402) {
    return { status: "out_of_credit", reset_at: null, reason: "insufficient credits (402)" };
  }

  if (response.status === 401 || response.status === 403) {
    return { status: "down", reset_at: null, reason: `auth failed (${response.status})` };
  }

  if (response.status === 429) {
    return {
      status: "degraded",
      reset_at: response.headers.get("x-ratelimit-reset"),
      reason: "rate limited (429)",
    };
  }

  if (response.status >= 500) {
    return { status: "down", reset_at: null, reason: `server error (${response.status})` };
  }

  if (response.ok) {
    let body: OpenRouterKeyBody = {};
    try {
      body = (await response.json()) as OpenRouterKeyBody;
    } catch {
      // Malformed/non-JSON body on an otherwise-2xx response — treat as up
      // rather than guessing at a credit state we can't read.
      return { status: "up", reset_at: null, reason: null };
    }
    const remaining = body.data?.limit_remaining;
    if (typeof remaining === "number" && remaining <= 0) {
      return {
        status: "out_of_credit",
        reset_at: null,
        reason: "limit_remaining reached zero (200 response)",
      };
    }
    return { status: "up", reset_at: null, reason: null };
  }

  return { status: "degraded", reset_at: null, reason: `unexpected status ${response.status}` };
}
