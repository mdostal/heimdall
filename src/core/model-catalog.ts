// Model catalog orchestration — hdl-mc-04. The shared-function home for
// model-catalog operations, mirroring http-server.ts's role for lane
// operations (getLaneStatuses/setLaneOverride/etc): one implementation,
// reused by both the HTTP routes and the MCP tools (hdl-mc-05).

import type { LaneRegistry } from "./lane-registry.js";
import type { StateStore, ModelCatalogEntry } from "./state-store.js";
import { defaultEnabledModelIds } from "./model-recency.js";
import { listClaudeModels } from "./signal-sources/model-list/claude.js";
import { listCodexModels } from "./signal-sources/model-list/codex.js";
import { listKimiModels } from "./signal-sources/model-list/kimi.js";
import { listGeminiModels } from "./signal-sources/model-list/gemini.js";
import type { RawModelEntry } from "./signal-sources/model-list/claude.js";

type ModelListFn = (credential: string, fetchImpl?: typeof fetch) => Promise<RawModelEntry[]>;

// The four providers this epic gates. OpenRouter/Ollama are deliberately
// excluded — see research-brief.md's scoping note (OpenRouter routes are
// already explicit per-lane declarations; Ollama has no deprecation
// concept at all).
const GATED_PROVIDER_LIST_FNS: Record<string, ModelListFn> = {
  claude: listClaudeModels,
  codex: listCodexModels,
  kimi: listKimiModels,
  gemini: listGeminiModels,
};

export interface RefreshModelCatalogResult {
  providersRefreshed: string[];
  modelsSeen: number;
}

/**
 * Fetches each configured lane's provider's live model list (deduped by
 * (provider, credential) so lanes sharing a credential — e.g. an
 * OpenRouter-style gateway, or simply two lanes on the same account —
 * don't double-fetch), diffs against the stored catalog, and applies the
 * recency-default heuristic ONLY to genuinely new (provider, model_id)
 * pairs. An operator's prior setModelEnabled choice is never touched by a
 * refresh — StateStore.upsertModelSeen already guarantees this at the
 * storage layer (hdl-mc-01).
 *
 * One provider/lane's fetch failure never aborts the rest of the refresh —
 * per-lane failure isolation, same posture as LanePipeline/
 * MulticaAutopilotScheduler elsewhere in this codebase.
 */
export async function refreshModelCatalog(
  store: StateStore,
  registry: LaneRegistry,
  fetchImpl?: typeof fetch,
  now: () => string = () => new Date().toISOString(),
): Promise<RefreshModelCatalogResult> {
  const seenCredentials = new Set<string>();
  const providersRefreshed: string[] = [];
  let modelsSeen = 0;

  for (const lane of registry.list()) {
    const listFn = GATED_PROVIDER_LIST_FNS[lane.provider];
    if (!listFn) continue; // ungated provider (openrouter, ollama, or unknown) — skip silently
    if (!lane.credential) continue; // unconfigured lane — nothing to fetch with

    // Dedup by credential_ref (the env-var NAME), never the resolved
    // secret value itself — matches this codebase's established
    // credential_ref-is-safe-to-reference / credential-is-never-exposed
    // distinction (e.g. GET /lanes's credential_ref field).
    const dedupeKey = `${lane.provider}:${lane.credential_ref}`;
    if (seenCredentials.has(dedupeKey)) continue;
    seenCredentials.add(dedupeKey);

    let entries: RawModelEntry[];
    try {
      entries = await listFn(lane.credential, fetchImpl);
    } catch {
      // Defensive — the list functions themselves already never throw
      // (hdl-mc-02), but this orchestration layer never assumes that of a
      // future provider addition either. One provider's failure must
      // never abort the rest of the refresh.
      continue;
    }
    if (entries.length === 0) continue;

    const seenAt = now();
    const existing = new Set(
      store.getModelCatalog(lane.provider).map((row) => row.model_id),
    );
    const newEntries = entries.filter((entry) => !existing.has(entry.id));
    const defaults = newEntries.length > 0 ? defaultEnabledModelIds(lane.provider, entries) : new Set<string>();

    for (const entry of entries) {
      store.upsertModelSeen({
        provider: lane.provider,
        model_id: entry.id,
        default_enabled: defaults.has(entry.id),
        provider_created_at: entry.createdAt,
        seen_at: seenAt,
      });
    }

    providersRefreshed.push(lane.provider);
    modelsSeen += entries.length;
  }

  return { providersRefreshed, modelsSeen };
}

export function getModelCatalog(store: StateStore, provider?: string): ModelCatalogEntry[] {
  return store.getModelCatalog(provider);
}

export type SetModelEnabledResult =
  | { ok: true; provider: string; model_id: string; enabled: boolean }
  | { ok: false; error: "unknown_model" };

export function setModelEnabled(
  store: StateStore,
  provider: string,
  modelId: string,
  enabled: boolean,
): SetModelEnabledResult {
  const updated = store.setModelEnabled(provider, modelId, enabled);
  if (!updated) {
    return { ok: false, error: "unknown_model" };
  }
  return { ok: true, provider, model_id: modelId, enabled };
}

export interface EffectiveModelResolution {
  model: string;
  substituted: boolean;
}

/**
 * hdl-mcr-01 — "what should I actually use right now," not just "what was
 * declared." Ungated providers and providers with no catalog data at all
 * (never refreshed) pass the declared model through unchanged — the latter
 * is a deliberate byte-identical fallback, not an oversight: no data means
 * no opinion. Only once a refresh has actually run for this provider does
 * substitution ever activate, and only when there's positive evidence the
 * declared model isn't usable (disabled, or missing from a non-empty
 * catalog — the live "this model is gone" signal).
 */
export function resolveEffectiveModel(
  store: StateStore,
  provider: string,
  declaredModel: string,
): EffectiveModelResolution {
  if (!(provider in GATED_PROVIDER_LIST_FNS)) {
    return { model: declaredModel, substituted: false };
  }

  const catalog = store.getModelCatalog(provider);
  if (catalog.length === 0) {
    return { model: declaredModel, substituted: false };
  }

  const declaredEntry = catalog.find((entry) => entry.model_id === declaredModel);
  if (declaredEntry?.enabled) {
    return { model: declaredModel, substituted: false };
  }

  const enabledCandidates = catalog.filter((entry) => entry.enabled);
  if (enabledCandidates.length === 0) {
    // No usable alternative — a wrong-but-present model beats returning
    // nothing at all.
    return { model: declaredModel, substituted: false };
  }

  const best = [...enabledCandidates].sort((a, b) =>
    (b.provider_created_at ?? "").localeCompare(a.provider_created_at ?? ""),
  )[0];
  return { model: best.model_id, substituted: true };
}
