// Gemini active-probe adapter — REQ-03 (hdl-gs-01).
// Source: .pHive/epics/hdl-gemini-signals/docs/research-brief.md — real web
// research against ai.google.dev's Gemini Developer API docs, 2026-08-13.
//
// Uses GET /v1beta/models as the minimal-cost real call (parallel to
// Claude's/Codex's adapters) — lightweight, authenticated, no generation
// cost. Auth via the x-goog-api-key header, NOT the documented-but-legacy
// ?key= query param — a credential in the URL risks appearing in proxy or
// access logs, and Google's current docs recommend the header form.
//
// GAP (documented, not an oversight): the Gemini Developer API has no
// documented reset-timestamp header or body field for 429 responses, unlike
// Claude's anthropic-ratelimit-requests-reset. reset_at is therefore always
// null here. InProcessScheduler already falls back to its flat polling
// interval whenever reset_at is unknown (hdl-reason-aware-recovery), so this
// degrades gracefully with zero new scheduler code.
//
// UNCONFIRMED (flagged for refinement once a real 429 is observed): the
// exact error.status string Google uses to distinguish a transient
// per-minute rate limit from a longer-lived daily-quota-exceeded condition
// — both surface as HTTP 429. Best-effort parse of the JSON body, falling
// back to the less-severe `degraded` verdict (never guessing out_of_credit)
// when the body doesn't clearly indicate a quota condition — same
// conservative-default posture codex.ts already uses for its own
// unconfirmed 429 body shape.

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
}

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiErrorBody {
  error?: { code?: number; status?: string; message?: string };
}

export async function probeGeminiLane(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(GEMINI_MODELS_URL, {
      method: "GET",
      headers: { "x-goog-api-key": apiKey },
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
    let body: GeminiErrorBody = {};
    try {
      body = (await response.json()) as GeminiErrorBody;
    } catch {
      // Malformed/non-JSON error body — fall through to the degraded default.
    }
    const status = body.error?.status ?? "";
    const message = body.error?.message ?? "";
    if (/quota/i.test(status) || /daily|per.?day/i.test(message)) {
      return {
        status: "out_of_credit",
        reset_at: null,
        reason: body.error?.message ?? "quota exceeded (429)",
      };
    }
    return {
      status: "degraded",
      reset_at: null,
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
