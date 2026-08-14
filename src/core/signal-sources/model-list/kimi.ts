// Kimi/Moonshot list-models fetcher — hdl-mc-02. Same URL/auth as
// active-probe/kimi.ts (api.moonshot.ai/v1/models, Bearer). Moonshot states
// OpenAI-format compatibility but this wasn't directly confirmed against a
// live response (research-brief.md) — `created` is read defensively, null
// when absent, never assumed present. model-recency.ts's heuristic already
// has a documented fallback (enable everything) for exactly this case.
//
// Never throws — see claude.ts's identical contract note.

import type { RawModelEntry } from "./claude.js";

const KIMI_MODELS_URL = "https://api.moonshot.ai/v1/models";

interface KimiModelsResponse {
  data?: { id?: string; created?: number }[];
}

export async function listKimiModels(
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RawModelEntry[]> {
  try {
    const response = await fetchImpl(KIMI_MODELS_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${credential}` },
    });
    if (!response.ok) return [];

    const body = (await response.json()) as KimiModelsResponse;
    if (!Array.isArray(body.data)) return [];

    return body.data
      .filter((entry): entry is { id: string; created?: number } => typeof entry.id === "string")
      .map((entry) => ({
        id: entry.id,
        createdAt: typeof entry.created === "number" ? new Date(entry.created * 1000).toISOString() : null,
      }));
  } catch {
    return [];
  }
}
