// Bearer-authenticated, OpenAI-compatible model list. Failures are isolated
// from other providers by returning an empty list.
import type { RawModelEntry } from "./claude.js";

export async function listGrokModels(
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RawModelEntry[]> {
  try {
    const response = await fetchImpl("https://api.x.ai/v1/models", {
      method: "GET",
      headers: { authorization: `Bearer ${credential}` },
    });
    if (!response.ok) return [];
    const body = await response.json() as { data?: unknown };
    if (!Array.isArray(body?.data)) return [];
    return body.data.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("id" in entry) ||
          typeof entry.id !== "string" || !entry.id.trim()) return [];
      const created = "created" in entry ? entry.created : null;
      const date = typeof created === "number" ? new Date(created * 1000) : null;
      return [{ id: entry.id, createdAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null }];
    });
  } catch {
    return [];
  }
}
