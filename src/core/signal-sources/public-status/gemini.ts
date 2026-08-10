// Gemini public-status adapter.

export type PublicStatusValue = "up" | "degraded" | "down";

export interface PublicStatusSignal {
  status: PublicStatusValue;
  reason: string | null;
}

// Google doesn't have a direct statuspage.io equivalent for Gemini API at a single simple JSON URL
// in the exact same format, so we provide a basic stub here that assumes up unless we know otherwise,
// similar to other implementations when the page is missing, or we can check Google Cloud Status
// if we had a specific JSON endpoint. For now, a simple stub.

export async function checkGeminiPublicStatus(
  fetchImpl: typeof fetch = fetch,
): Promise<PublicStatusSignal> {
  // To avoid false positives on downtime when we don't have a structured status API,
  // we assume "up" for the public status and rely on the active probe for failure detection.
  return {
    status: "up",
    reason: null,
  };
}
