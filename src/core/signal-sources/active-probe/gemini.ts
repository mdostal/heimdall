// Gemini active-probe adapter.
// Validates Google Gemini models.

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
}

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export async function probeGeminiLane(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${GEMINI_MODELS_URL}?key=${apiKey}`, {
      method: "GET",
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
    let body: any = {};
    try {
      body = await response.json();
    } catch {}

    const message = body.error?.message ?? "";
    if (/quota/i.test(message)) {
      return { status: "out_of_credit", reset_at: null, reason: message || "insufficient quota" };
    }
    return {
      status: "degraded",
      reset_at: null,
      reason: message || "rate limited (429)",
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
