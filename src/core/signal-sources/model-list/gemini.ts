// Gemini list-models fetcher — hdl-mc-02. Same URL/auth as
// active-probe/gemini.ts (generativelanguage.googleapis.com/v1beta/models,
// x-goog-api-key). Confirmed (research-brief.md): entries have NO date
// field at all — createdAt is always null here. model-recency.ts's Gemini
// branch uses a generation-number heuristic on the id instead.
//
// The top-level response key is `models` (not `data`, unlike the
// OpenAI-convention providers), and each entry's identifier is `name`
// (e.g. "models/gemini-3-pro-preview") — stripped of its "models/" prefix
// to match the bare id shape every other provider's entries already use.
//
// Never throws — see claude.ts's identical contract note.

import type { RawModelEntry } from "./claude.js";

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL_NAME_PREFIX = "models/";

interface GeminiModelsResponse {
  models?: { name?: string }[];
}

export async function listGeminiModels(
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RawModelEntry[]> {
  try {
    const response = await fetchImpl(GEMINI_MODELS_URL, {
      method: "GET",
      headers: { "x-goog-api-key": credential },
    });
    if (!response.ok) return [];

    const body = (await response.json()) as GeminiModelsResponse;
    if (!Array.isArray(body.models)) return [];

    return body.models
      .filter((entry): entry is { name: string } => typeof entry.name === "string")
      .map((entry) => ({
        id: entry.name.startsWith(MODEL_NAME_PREFIX) ? entry.name.slice(MODEL_NAME_PREFIX.length) : entry.name,
        createdAt: null,
      }));
  } catch {
    return [];
  }
}
