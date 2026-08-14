import type { LaneRegistry } from "./lane-registry.js";
import type { StateStore } from "./state-store.js";
import { createRoutingStrategyRegistry, DEFAULT_ROUTING_STRATEGY_NAME } from "./routing-strategies/registry.js";
import { resolveEffectiveModel } from "./model-catalog.js";

export const TASK_TYPES = ["planning", "build", "review"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export interface AvailableRoute {
  runtime: string;
  model: string;
  "token-ref": string;
  lane_id: string;
  task_type: TaskType;
  headroom: true;
  /** hdl-mcr-01 — true when `model` isn't the lane's raw declared
   * HEIMDALL_LANE_N_MODEL, because the model-catalog (hdl-model-catalog)
   * found it disabled or gone and substituted the newest enabled
   * alternative instead. Never silent — GET /lanes still reports the raw
   * declared value unchanged for any caller that needs it. */
  model_substituted: boolean;
}

// hdl-rs-02: one module-level registry, created once for the process
// lifetime — matters specifically for RoundRobinStrategy, whose rotation
// state must persist ACROSS requests to actually rotate (a fresh registry
// per call would reset the cursor every time). Mirrors RUNTIME_PRIORITY's
// own pre-hdl-rs-02 module-level-const lifetime.
const routingStrategies = createRoutingStrategyRegistry();

// hdl-rs-03: the settings key the active strategy is persisted under, and
// the read-side resolution (default when unset) — the write side
// (validating + persisting an operator-chosen name) lives in
// http-server.ts's setRoutingStrategy, alongside the other shared mutation
// functions (setLaneOverride/setLaneResetAt/addLane).
export const ROUTING_STRATEGY_SETTING_KEY = "routing_strategy";

export function getRoutingStrategyNames(): string[] {
  return Object.keys(routingStrategies);
}

export function getActiveRoutingStrategyName(store: StateStore): string {
  const stored = store.getSetting(ROUTING_STRATEGY_SETTING_KEY);
  return stored && routingStrategies[stored] ? stored : DEFAULT_ROUTING_STRATEGY_NAME;
}

export function parseTaskType(value: string | null): TaskType | null {
  return TASK_TYPES.find((taskType) => taskType === value) ?? null;
}

export function getAvailableRoute(
  taskType: TaskType,
  registry: LaneRegistry,
  store: StateStore,
): AvailableRoute | null {
  for (const lane of registry.list()) {
    store.upsertLane({
      lane_id: lane.lane_id,
      provider: lane.provider,
      credential_ref: lane.credential_ref,
    });
  }

  const statuses = new Map(store.getAllCurrentStatuses().map((status) => [status.lane_id, status]));
  const candidates = registry
    .list()
    .filter((lane) => lane.credential !== null)
    .filter((lane) => {
      // hdl-rs-01: manual_override gates routing candidacy the SAME way it
      // already gates Multica actuation (MulticaControlAdapter.reconcile) —
      // "disabled" blocks a lane from being routed to no matter its sensed
      // status; "enabled" forces it in even if sensed status isn't "up";
      // unset (null) is byte-identical to pre-hdl-rs-01 behavior.
      const override = store.getManualOverride(lane.lane_id);
      if (override === "disabled") return false;
      if (override === "enabled") return true;
      return statuses.get(lane.lane_id)?.status === "up";
    });

  const strategy = routingStrategies[getActiveRoutingStrategyName(store)];
  const lane = strategy.selectRoute(taskType, candidates);
  if (!lane) return null;

  const { model, substituted } = resolveEffectiveModel(store, lane.provider, lane.model);

  return {
    runtime: lane.provider,
    model,
    "token-ref": lane.credential_ref,
    lane_id: lane.lane_id,
    task_type: taskType,
    headroom: true,
    model_substituted: substituted,
  };
}
