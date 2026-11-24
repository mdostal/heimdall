// heimdall#142 slice 2: the models a lane can serve, each with an operator
// toggle (`enabled`) and a limit-derived `available`.
//
// Where the model list comes from (config, never constants):
// 1. the lane's declared `models` (HEIMDALL_LANE_<N>_MODELS or `models` in
//    HEIMDALL_LANES_JSON), with an optional operator-set `tier`;
// 2. the lane's own `model`, when it names a real model;
// 3. when the lane declares no `models`, the provider's enabled entries in
//    the model catalog (refreshed from the provider itself);
// 4. any model a recorded `weekly_model:<id>` limit names: the account
//    reported a limit on it, so it serves it.
//
// `enabled` is the operator's lane toggle when one is set; otherwise the
// provider-wide catalog flag when the catalog knows the model; otherwise on.
// `available` is false while a limit that blocks the model is exhausted: its
// own `weekly_model:<id>` limit, or an account-wide `five_hour` /
// `weekly_all_models` limit. It turns true by itself once `resets_at` passes
// (effectiveLimit) or the limit is cleared.
//
// This module only reports. Routing on it (swap and swap-back) is slice 4,
// and dispatch stays Auriga's.

import type { Lane, LaneRegistry } from "./lane-registry.js";
import type { LaneLimit } from "./limits.js";
import type { LaneModelToggle, ModelCatalogEntry, StateStore } from "./state-store.js";

/** Account-wide limits that stop every model on the account while exhausted. */
const ACCOUNT_BLOCKING_KINDS = new Set(["five_hour", "weekly_all_models"]);

export type LaneModelSource = "lane_config" | "lane_model" | "catalog" | "limit";

export interface LaneModel {
  model_id: string;
  /** Operator-configured tier from lane config; null when none is configured. */
  tier: string | null;
  /** Where this model entry came from (see the module comment). */
  source: LaneModelSource;
  /** The effective on/off: the lane toggle if set, else the catalog flag, else true. */
  enabled: boolean;
  /** The operator's lane toggle; null means auto. */
  manual: "enabled" | "disabled" | null;
  override_reason: string | null;
  /** When the lane toggle expires and the model returns to auto; null when no expiry. */
  override_until: string | null;
  /** False while an exhausted limit blocks this model. */
  available: boolean;
  /** The exhausted limit kinds that make this model unavailable; [] when available. */
  blocked_by: string[];
  /** When every blocking limit has reset, if each reported a reset time; else null. */
  available_at: string | null;
  /** enabled && available. */
  usable: boolean;
}

/** The exhausted limits that stop `modelId`: its own weekly_model limit or an account-wide one. */
export function blockingLimits(modelId: string, limits: LaneLimit[]): LaneLimit[] {
  return limits.filter(
    (limit) => limit.state === "exhausted" && (limit.model === modelId || ACCOUNT_BLOCKING_KINDS.has(limit.kind)),
  );
}

function availableAt(blocking: LaneLimit[]): string | null {
  if (blocking.length === 0) return null;
  let latest: string | null = null;
  for (const limit of blocking) {
    if (limit.resets_at === null) return null;
    if (latest === null || Date.parse(limit.resets_at) > Date.parse(latest)) latest = limit.resets_at;
  }
  return latest;
}

/** A lane's `model` defaults to its provider name when unset; that is not a model id. */
function laneModelId(lane: Lane): string | null {
  return lane.model && lane.model !== lane.provider ? lane.model : null;
}

export function buildLaneModels(
  lane: Lane,
  limits: LaneLimit[],
  toggles: LaneModelToggle[],
  catalog: ModelCatalogEntry[],
): LaneModel[] {
  const entries = new Map<string, { tier: string | null; source: LaneModelSource }>();
  for (const model of lane.models) entries.set(model.id, { tier: model.tier ?? null, source: "lane_config" });
  const own = laneModelId(lane);
  if (own && !entries.has(own)) entries.set(own, { tier: null, source: "lane_model" });
  if (lane.models.length === 0) {
    for (const entry of catalog) {
      if (entry.enabled && !entries.has(entry.model_id)) entries.set(entry.model_id, { tier: null, source: "catalog" });
    }
  }
  for (const limit of limits) {
    if (limit.model && !entries.has(limit.model)) entries.set(limit.model, { tier: null, source: "limit" });
  }

  const toggleById = new Map(toggles.map((toggle) => [toggle.model_id, toggle]));
  const catalogById = new Map(catalog.map((entry) => [entry.model_id, entry]));
  return [...entries.entries()].map(([modelId, { tier, source }]) => {
    const toggle = toggleById.get(modelId);
    const catalogEntry = catalogById.get(modelId);
    const enabled = toggle ? toggle.enabled : catalogEntry ? catalogEntry.enabled : true;
    const blocking = blockingLimits(modelId, limits);
    const available = blocking.length === 0;
    return {
      model_id: modelId,
      tier,
      source,
      enabled,
      manual: toggle ? (toggle.enabled ? "enabled" : "disabled") : null,
      override_reason: toggle?.reason ?? null,
      override_until: toggle?.until ?? null,
      available,
      blocked_by: blocking.map((limit) => limit.kind),
      available_at: availableAt(blocking),
      usable: enabled && available,
    };
  });
}

/** One lane's models as they stand at `now`. */
export function getLaneModels(lane: Lane, store: StateStore, now: Date = new Date()): LaneModel[] {
  return buildLaneModels(
    lane,
    store.getLimits(lane.lane_id, now),
    store.getLaneModelToggles(lane.lane_id, now),
    store.getModelCatalog(lane.provider),
  );
}

export type ListLaneModelsResult =
  | { ok: true; lane_id: string; models: LaneModel[] }
  | { ok: false; error: "unknown_lane"; lane_id: string };

export function listLaneModels(registry: LaneRegistry, store: StateStore, laneId: string, now: Date = new Date()): ListLaneModelsResult {
  const lane = registry.get(laneId);
  if (!lane) return { ok: false, error: "unknown_lane", lane_id: laneId };
  return { ok: true, lane_id: laneId, models: getLaneModels(lane, store, now) };
}

export type SetLaneModelEnabledResult =
  | { ok: true; lane_id: string; model: LaneModel }
  | { ok: false; error: "unknown_lane"; lane_id: string }
  | { ok: false; error: "unknown_model"; lane_id: string; model_id: string; known_models: string[] }
  | { ok: false; error: "invalid_enabled"; message: string }
  | { ok: false; error: "invalid_reason"; message: string }
  | { ok: false; error: "invalid_until"; message: string };

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * "Turn Fable off" / "turn Fable back on": one call. `enabled` is true, false,
 * or null (back to auto). `until` is an optional future ISO-8601 expiry with a
 * timezone, after which the toggle drops back to auto (#126's pattern).
 * Shared by HTTP, MCP and the dashboard so all three validate the same way.
 */
export function setLaneModelEnabled(
  registry: LaneRegistry,
  store: StateStore,
  laneId: string,
  modelId: string,
  rawEnabled: unknown,
  rawReason?: unknown,
  rawUntil?: unknown,
  now: Date = new Date(),
): SetLaneModelEnabledResult {
  const lane = registry.get(laneId);
  if (!lane) return { ok: false, error: "unknown_lane", lane_id: laneId };
  if (rawEnabled !== true && rawEnabled !== false && rawEnabled !== null) {
    return { ok: false, error: "invalid_enabled", message: "enabled must be true, false, or null (back to auto)" };
  }
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== "string") {
    return { ok: false, error: "invalid_reason", message: "reason must be a string or null" };
  }
  if (rawUntil !== undefined && rawUntil !== null &&
      (typeof rawUntil !== "string" || !ISO_WITH_ZONE.test(rawUntil) || !Number.isFinite(Date.parse(rawUntil)) || Date.parse(rawUntil) <= now.getTime())) {
    return { ok: false, error: "invalid_until", message: "until must be a future ISO-8601 timestamp with timezone" };
  }
  const known = getLaneModels(lane, store, now);
  if (!known.some((model) => model.model_id === modelId)) {
    return { ok: false, error: "unknown_model", lane_id: laneId, model_id: modelId, known_models: known.map((model) => model.model_id) };
  }
  const enabled = rawEnabled as boolean | null;
  const reason = enabled !== null && typeof rawReason === "string" && rawReason.trim() !== "" ? rawReason : null;
  const until = enabled !== null && typeof rawUntil === "string" ? new Date(rawUntil).toISOString() : null;
  store.setLaneModelToggle(laneId, modelId, enabled, reason, until, now);
  const model = getLaneModels(lane, store, now).find((entry) => entry.model_id === modelId)!;
  return { ok: true, lane_id: laneId, model };
}

export interface ModelUsability {
  enabled: boolean;
  available: boolean;
  blocked_by: string[];
  available_at: string | null;
}

/**
 * heimdall#142 slice 3: whether `modelId` is usable on `lane` right now, for
 * routing. Uses the lane's model list when the model is on it; otherwise (a
 * catalog substitute, or a lane with no model id) applies the same rules
 * directly: the lane toggle, then the catalog flag, and any exhausted limit
 * that blocks the model.
 */
export function getModelUsability(lane: Lane, modelId: string, store: StateStore, now: Date = new Date()): ModelUsability {
  const listed = getLaneModels(lane, store, now).find((model) => model.model_id === modelId);
  if (listed) {
    return { enabled: listed.enabled, available: listed.available, blocked_by: listed.blocked_by, available_at: listed.available_at };
  }
  const toggle = store.getLaneModelToggles(lane.lane_id, now).find((entry) => entry.model_id === modelId);
  const catalogEntry = store.getModelCatalog(lane.provider).find((entry) => entry.model_id === modelId);
  const blocking = blockingLimits(modelId, store.getLimits(lane.lane_id, now));
  return {
    enabled: toggle ? toggle.enabled : catalogEntry ? catalogEntry.enabled : true,
    available: blocking.length === 0,
    blocked_by: blocking.map((limit) => limit.kind),
    available_at: availableAt(blocking),
  };
}
