// Ollama active-probe adapter — REQ-03 (hdl-ol-01). Liveness-only, by
// operator decision: "liveliness it doesn't really have a path -- it should
// have liveliness so we can signal off of it mostly" (2026-08-13, resolving
// the Ollama half of the earlier design-options artifact).
//
// GET <baseUrl>/api/tags, no auth header — Ollama's local API is
// unauthenticated. Lists locally-installed models; proves the actual Ollama
// API is answering correctly, not just that something is listening on the
// port.
//
// baseUrl arrives via the same `credential` parameter every probe()
// function already receives — repurposed to carry a base URL instead of a
// secret (see .pHive/epics/hdl-ollama-signals/docs/research-brief.md's
// design simplification: an operator points HEIMDALL_LANE_<N>_CREDENTIAL_REF
// at an env var holding the instance's base URL, e.g.
// OLLAMA_HOST=http://localhost:11434, instead of a secret — this flows
// through the existing, unmodified credential-resolution pipeline with zero
// schema changes). A value that doesn't look like a URL (including empty)
// defaults to the standard local Ollama port.
//
// Only up/down are possible — no degraded, no out_of_credit, no reset_at.
// Confirmed: local, unauthenticated inference has no quota/rate-limit/
// billing concept to signal those states honestly.

export type ProbeStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export interface ProbeResult {
  status: ProbeStatusValue;
  reset_at: string | null;
  reason: string | null;
}

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

function resolveBaseUrl(credential: string): string {
  return credential.startsWith("http://") || credential.startsWith("https://")
    ? credential
    : DEFAULT_OLLAMA_BASE_URL;
}

export async function probeOllamaLane(
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const baseUrl = resolveBaseUrl(credential);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/tags`, { method: "GET" });
  } catch (err) {
    return {
      status: "down",
      reset_at: null,
      reason: `probe request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return { status: "down", reset_at: null, reason: `unexpected status ${response.status}` };
  }

  try {
    await response.json();
  } catch (err) {
    return {
      status: "down",
      reset_at: null,
      reason: `malformed response body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { status: "up", reset_at: null, reason: null };
}
