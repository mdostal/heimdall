// Claude list-models fetcher — hdl-mc-02. Same URL/auth as
// active-probe/claude.ts's api-key path (api.anthropic.com/v1/models,
// x-api-key + anthropic-version), but returns the raw model list instead
// of a liveness verdict. Confirmed via Anthropic's own docs
// (research-brief.md): each entry has `created_at`, and the list is
// already returned newest-first.
//
// Never throws — an unreachable endpoint or malformed response returns []
// rather than propagating an error; the orchestration layer (hdl-mc-04)
// decides what an empty result means for catalog state.

export interface RawModelEntry {
  id: string;
  createdAt: string | null;
}

const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION = "2023-06-01";

interface ClaudeModelsResponse {
  data?: { id?: string; created_at?: string }[];
}

export async function listClaudeModels(
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RawModelEntry[]> {
  try {
    const response = await fetchImpl(CLAUDE_MODELS_URL, {
      method: "GET",
      headers: {
        "x-api-key": credential,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
    });
    if (!response.ok) return [];

    const body = (await response.json()) as ClaudeModelsResponse;
    if (!Array.isArray(body.data)) return [];

    return body.data
      .filter((entry): entry is { id: string; created_at?: string } => typeof entry.id === "string")
      .map((entry) => ({
        id: entry.id,
        createdAt: typeof entry.created_at === "string" ? entry.created_at : null,
      }));
  } catch {
    return [];
  }
}
