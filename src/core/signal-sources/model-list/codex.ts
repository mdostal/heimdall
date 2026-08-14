// Codex/OpenAI list-models fetcher — hdl-mc-02. Same URL/auth as
// active-probe/codex.ts (api.openai.com/v1/models, Bearer), but returns
// the raw model list. Confirmed (research-brief.md): each entry has a
// `created` Unix-timestamp field — the long-standing OpenAI convention.
//
// Never throws — see claude.ts's identical contract note.

import type { RawModelEntry } from "./claude.js";

const CODEX_MODELS_URL = "https://api.openai.com/v1/models";

interface CodexModelsResponse {
  data?: { id?: string; created?: number }[];
}

export async function listCodexModels(
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RawModelEntry[]> {
  try {
    const response = await fetchImpl(CODEX_MODELS_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${credential}` },
    });
    if (!response.ok) return [];

    const body = (await response.json()) as CodexModelsResponse;
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
