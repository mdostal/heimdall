// heimdall#142 slice 4: swap and swap-back in the route verdict.
//
// A lane is one account. When the model it would route (its preferred model:
// the lane's configured model after any catalog substitution) is blocked by
// an exhausted limit or switched off, and the same lane serves another model
// that is usable and at an allowed level no lower than the preferred one,
// the route names that model instead. On 11/15 that is "Fable is out, route
// Opus on the same subscription" rather than idling every agent.
//
// - Preference order is configuration: the order of the lane's declared
//   models (HEIMDALL_LANE_<N>_MODELS / `models` in HEIMDALL_LANES_JSON), then
//   the catalog. No model names live here.
// - Never below premium: the target's level must be one the work class
//   allows (slice 3) and no lower than the preferred model's. A premium
//   preference only ever swaps to another premium model, so a build never
//   lands on Sonnet or Haiku through a swap.
// - Swap-back needs no step: every decision recomputes from the limits, so
//   once `resets_at` passes or an operator clears the limit, the preferred
//   model is usable and routed again.
// - Every transition (swap, swap-back) is logged once, to the route ledger
//   and to telemetry, with the limit that caused it. The current swap per
//   lane is persisted so a swap-back can name its cause after a restart.
//
// Heimdall decides and reports the model; Auriga dispatches with it.

import type { Lane } from "./lane-registry.js";
import type { StateStore } from "./state-store.js";
import type { LaneLimit } from "./limits.js";
import { blockingLimits, getLaneModels } from "./lane-models.js";
import { LEVELS, resolveLevel, type Level, type LevelPolicy } from "./routing/levels.js";
import type { JsonValue, ModelSwapEventInput } from "./routing/route-ledger.js";

/** One limit that blocked the preferred model, as reported with a swap. */
export interface ModelSwapLimit {
  kind: string;
  state: string;
  used_percent: number | null;
  resets_at: string | null;
  source: string;
  observed_at: string;
  /** The provider's own words (e.g. "You've reached your Fable limit"). */
  reason: string | null;
}

export interface ModelSwapCause {
  /** `limit`: an exhausted limit blocks the preferred model. `model_disabled`: the operator turned it off. */
  type: "limit" | "model_disabled";
  /** The exhausted limits blocking the preferred model ([] for model_disabled with no limit). */
  limits: ModelSwapLimit[];
  /** For model_disabled: the operator's reason and expiry, when given. */
  toggle_reason: string | null;
  toggle_until: string | null;
  /** When the preferred model is expected back (every blocking limit reported a reset); else null. */
  preferred_available_at: string | null;
}

export interface ModelSwap {
  lane_id: string;
  /** The model the lane prefers (and returns to by itself). */
  preferred_model: string;
  /** The model to dispatch with instead. */
  model: string;
  level: Level;
  cause: ModelSwapCause;
}

export interface LaneModelPlan {
  /** Non-null when the lane should route another model. */
  swap: ModelSwap | null;
  /** When no swap target is usable now: when each allowed-level alternative on this lane is expected back. */
  alternatives_available_at: string[];
}

function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

function toSwapLimit(limit: LaneLimit): ModelSwapLimit {
  return {
    kind: limit.kind,
    state: limit.state,
    used_percent: limit.used_percent,
    resets_at: limit.resets_at,
    source: limit.source,
    observed_at: limit.observed_at,
    reason: limit.reason,
  };
}

/**
 * Picks the model `lane` should route when its preferred model is blocked:
 * the first model in the lane's configured order that is enabled, available,
 * at a level the work class allows, and no lower than the preferred model.
 */
export function planLaneModel(
  lane: Lane,
  preferredModel: string,
  preferredLevel: Level,
  preferredUsability: { enabled: boolean; available: boolean; available_at: string | null },
  allowed: readonly Level[],
  policy: LevelPolicy,
  store: StateStore,
  now: Date,
): LaneModelPlan {
  const alternativesAvailableAt: string[] = [];
  for (const candidate of getLaneModels(lane, store, now)) {
    if (candidate.model_id === preferredModel) continue;
    const { level } = resolveLevel(policy, lane, candidate.model_id);
    if (level === null || !allowed.includes(level) || levelRank(level) > levelRank(preferredLevel)) continue;
    if (!candidate.enabled) continue;
    if (!candidate.available) {
      if (candidate.available_at !== null) alternativesAvailableAt.push(candidate.available_at);
      continue;
    }
    const limits = blockingLimits(preferredModel, store.getLimits(lane.lane_id, now)).map(toSwapLimit);
    const toggle = preferredUsability.enabled
      ? undefined
      : store.getLaneModelToggles(lane.lane_id, now).find((entry) => entry.model_id === preferredModel);
    return {
      swap: {
        lane_id: lane.lane_id,
        preferred_model: preferredModel,
        model: candidate.model_id,
        level,
        cause: {
          type: preferredUsability.enabled ? "limit" : "model_disabled",
          limits,
          toggle_reason: toggle?.reason ?? null,
          toggle_until: toggle?.until ?? null,
          preferred_available_at: preferredUsability.enabled ? preferredUsability.available_at : (toggle?.until ?? null),
        },
      },
      alternatives_available_at: [],
    };
  }
  return { swap: null, alternatives_available_at: alternativesAvailableAt };
}

/** The limit kinds (or "model_disabled") a cause names, for one-line text and telemetry labels. */
export function describeCause(cause: ModelSwapCause): string {
  if (cause.type === "model_disabled") return "model_disabled";
  return cause.limits.length > 0 ? cause.limits.map((limit) => limit.kind).join(",") : "limit";
}

function causeToJson(cause: ModelSwapCause): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(cause)) as Record<string, JsonValue>;
}

function parseCause(raw: string): ModelSwapCause | null {
  try {
    return JSON.parse(raw) as ModelSwapCause;
  } catch {
    return null;
  }
}

/**
 * Why the preferred model is usable again, for a swap-back:
 * `limit_cleared` (an operator cleared a causing limit), `limit_reset` (its
 * resets_at passed), `limit_available` (a later observation found room),
 * `model_enabled` (the toggle was cleared or expired), `preference_changed`
 * (the lane's configured model changed while swapped).
 */
export function swapBackResolution(
  cause: ModelSwapCause | null,
  preferredChanged: boolean,
  currentLimits: LaneLimit[],
  now: Date,
): string {
  if (preferredChanged) return "preference_changed";
  if (!cause) return "unknown";
  if (cause.type === "model_disabled") return "model_enabled";
  const byKind = new Map<string, LaneLimit>(currentLimits.map((limit) => [limit.kind, limit]));
  if (cause.limits.some((limit) => !byKind.has(limit.kind))) return "limit_cleared";
  const reset = cause.limits.some((limit) => {
    const resetsAt = byKind.get(limit.kind)?.resets_at ?? null;
    return resetsAt !== null && Date.parse(resetsAt) <= now.getTime();
  });
  return reset ? "limit_reset" : "limit_available";
}

export type SwapEventSink = (event: ModelSwapEventInput) => void;

function logEvent(store: StateStore, sink: SwapEventSink, lane: Lane, event: ModelSwapEventInput): void {
  try {
    sink(event);
  } catch (error) {
    // Routing is critical-path: a lost ledger row must not fail the decision.
    console.error(`model swap: failed to record ${event.event} for lane ${lane.lane_id} in the ledger`, error);
  }
  const cause = event.cause as unknown as ModelSwapCause;
  store.recordTelemetryEvent(event.event === "swap" ? "model_swap" : "model_swap_back", {
    provider: lane.provider,
    laneId: lane.lane_id,
    fromModel: event.fromModel,
    toModel: event.toModel,
    cause: Array.isArray(cause?.limits) ? describeCause(cause) : "unknown",
    ...(event.resolution !== null ? { resolution: event.resolution } : {}),
  }, event.recordedAt);
}

/**
 * Records a lane's swap state after a decision evaluated it, logging only
 * transitions:
 * - `swap` non-null: a swap starts (or moves to a different target).
 * - `swap` null and `preferredRouted`: the lane routes its preferred model
 *   again, so a stored swap ends with a swap-back.
 * - otherwise (nothing usable on the lane): the stored swap stays, and the
 *   swap-back is logged once the preferred model is routed again.
 */
export function recordSwapState(
  store: StateStore,
  sink: SwapEventSink,
  lane: Lane,
  preferredModel: string,
  swap: ModelSwap | null,
  preferredRouted: boolean,
  now: Date,
): void {
  const recordedAt = now.toISOString();
  if (swap) {
    if (store.startLaneModelSwap(lane.lane_id, swap.preferred_model, swap.model, JSON.stringify(swap.cause), now)) {
      logEvent(store, sink, lane, {
        event: "swap",
        laneId: lane.lane_id,
        fromModel: swap.preferred_model,
        toModel: swap.model,
        cause: causeToJson(swap.cause),
        resolution: null,
        recordedAt,
      });
    }
    return;
  }
  if (!preferredRouted) return;
  const stored = store.getLaneModelSwap(lane.lane_id);
  if (!stored || !store.endLaneModelSwap(stored)) return;
  const cause = parseCause(stored.cause);
  logEvent(store, sink, lane, {
    event: "swap_back",
    laneId: lane.lane_id,
    fromModel: stored.swapped_to,
    toModel: preferredModel,
    cause: cause ? causeToJson(cause) : {},
    resolution: swapBackResolution(cause, stored.preferred_model !== preferredModel, store.getLimits(lane.lane_id, now), now),
    recordedAt,
  });
}
