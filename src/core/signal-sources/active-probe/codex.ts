// Codex active-probe adapter — REQ-03.
//
// HONESTY NOTE (per signal-inventory.md): the spike confirmed Codex CLI's
// usage-limit message ("You've hit your usage limit ... try again at
// [date/time]") is free text in a CLI-surfaced string, NOT a structured HTTP
// response field — that finding applies to the `codex` CLI's own output, a
// different surface than the raw OpenAI Platform API this adapter probes via
// HTTP (mirroring lhs-03c's Claude pattern for architectural consistency).
// The spike found no official schema for OpenAI's raw API error codes in
// this pass — treat the 429/quota mapping below as a reasonable default,
// flagged for refinement once a real Codex lane is tested against it.
//
// Uses GET /v1/models as the minimal-cost real call (parallel to Claude's
// adapter) — lightweight, authenticated, no completion tokens spent.

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
}

const CODEX_MODELS_URL = "https://api.openai.com/v1/models";

interface OpenAiErrorBody {
  error?: { code?: string; type?: string; message?: string };
}

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
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { status: "down", reset_at: null, reason: `auth failed (${response.status})` };
  }

  if (response.status === 429) {
    // OpenAI does not use a distinct HTTP status for billing/quota failures
    // the way Anthropic's 402 does — both rate-limiting and insufficient
    // quota surface as 429, distinguished by the error body's code/type.
    // UNCONFIRMED by this spike pass (see file header) — best-effort parse,
    // falls back to `degraded` (rate limited) rather than guessing wrong.
    let body: OpenAiErrorBody = {};
    try {
      body = (await response.json()) as OpenAiErrorBody;
    } catch {
      // Malformed/non-JSON error body — fall through to the degraded default.
    }
    const code = body.error?.code ?? body.error?.type ?? "";
    if (/insufficient_quota|billing/i.test(code)) {
      return { status: "out_of_credit", reset_at: null, reason: body.error?.message ?? "insufficient quota" };
    }
    return {
      status: "degraded",
      reset_at: response.headers.get("retry-after"),
      reason: body.error?.message ?? "rate limited (429)",
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
