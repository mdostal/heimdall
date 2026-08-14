import type { Lane, LaneRegistry } from "./lane-registry.js";
import type { StateStore } from "./state-store.js";
import { createRoutingStrategyRegistry, DEFAULT_ROUTING_STRATEGY_NAME } from "./routing-strategies/registry.js";
import { ScoredStrategy } from "./routing-strategies/scored-strategy.js";
import { resolveEffectiveModel } from "./model-catalog.js";
import { TASK_TYPES, type TaskType, parseTaskType } from "./task-type.js";

export { TASK_TYPES, type TaskType, parseTaskType };

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
  /** hdl-rr-02 — populated only when the active strategy's selectRoute()
   * returns a `detail` (today, only the "scored" strategy does); absent
   * for priority/round-robin/off, exactly as before this field existed. */
  rationale?: string;
  decision_id?: string;
  experiment_arm?: string;
  ranked_candidates?: ReadonlyArray<{ laneId: string; score: number }>;
  policy_version?: string;
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

// hdl-rr-03: shared candidacy filtering — used by both getAvailableRoute
// (active-strategy-driven) and getScoredRoute (always-scored, bypasses the
// active-strategy setting). One definition of "which lanes are even
// eligible to be routed to" for every routing surface.
function getRoutingCandidates(registry: LaneRegistry, store: StateStore): Lane[] {
  for (const lane of registry.list()) {
    store.upsertLane({
      lane_id: lane.lane_id,
      provider: lane.provider,
      credential_ref: lane.credential_ref,
    });
  }

  const statuses = new Map(store.getAllCurrentStatuses().map((status) => [status.lane_id, status]));
  return registry
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
}

export function getAvailableRoute(
  taskType: TaskType,
  registry: LaneRegistry,
  store: StateStore,
): AvailableRoute | null {
  const candidates = getRoutingCandidates(registry, store);

  const strategy = routingStrategies[getActiveRoutingStrategyName(store)];
  const { lane, detail } = strategy.selectRoute({ taskType, candidates, store });
  if (!lane) return null;

  const { model, substituted } = resolveEffectiveModel(store, lane.provider, lane.model);
  if (substituted) {
    // hdl-ot-02: Heimdall's own local record — this fact previously existed
    // only as the response's model_substituted:true field for whoever
    // happened to make THIS specific call; no local history of it existed.
    store.recordTelemetryEvent("model_substitution", {
      provider: lane.provider,
      laneId: lane.lane_id,
      declaredModel: lane.model,
      effectiveModel: model,
    });
  }

  return {
    runtime: lane.provider,
    model,
    "token-ref": lane.credential_ref,
    lane_id: lane.lane_id,
    task_type: taskType,
    headroom: true,
    model_substituted: substituted,
    ...(detail?.rationale !== undefined ? { rationale: detail.rationale } : {}),
    ...(detail?.decisionId !== undefined ? { decision_id: detail.decisionId } : {}),
    ...(detail?.experimentArm !== undefined ? { experiment_arm: detail.experimentArm } : {}),
    ...(detail?.rankedCandidates !== undefined ? { ranked_candidates: detail.rankedCandidates } : {}),
    ...(detail?.policyVersion !== undefined ? { policy_version: detail.policyVersion } : {}),
  };
}

// hdl-rr-03: dev's original RouteResult contract, preserved for the
// backward-compatible POST /route / CLI route / MCP route_selection surfaces
// (Auriga/Minerva's existing dispatch contract per dev-assessment.md) — a
// thin reshape of RouteSelectionResult.detail, not a second implementation.
export interface RouteRequest {
  task_id: string;
  task_type: TaskType;
  estimated_cost?: number;
}

export interface RouteResult {
  decision_id: string | null;
  chosen_lane: string | null;
  ranked_candidates: ReadonlyArray<{ laneId: string; score: number }>;
  rationale: string;
  experiment_arm: string | null;
  policy_version: string | null;
}

// hdl-rr-03: one module-level ScoredStrategy instance — mirrors
// routingStrategies' own module-level lifetime, so the policy file and
// ledger DB connection load once, not per call. Always used for POST /route
// regardless of the globally active strategy (a caller hitting this
// endpoint is explicitly asking for the scored contract).
const scoredStrategyForRouteEndpoint = new ScoredStrategy();

/** hdl-ot-03: reuses the exact same module-level ledger connection getScoredRoute() writes to — GET /metrics reads through this, no second connection opened. */
export function getRoutingDecisionCounts(): ReturnType<ScoredStrategy["getDecisionCounts"]> {
  return scoredStrategyForRouteEndpoint.getDecisionCounts();
}

export function getScoredRoute(request: RouteRequest, registry: LaneRegistry, store: StateStore): RouteResult {
  const candidates = getRoutingCandidates(registry, store);
  const { lane, detail } = scoredStrategyForRouteEndpoint.selectRoute({
    taskType: request.task_type,
    candidates,
    store,
    taskId: request.task_id,
  });

  return {
    decision_id: detail?.decisionId ?? null,
    chosen_lane: lane?.lane_id ?? null,
    ranked_candidates: detail?.rankedCandidates ?? [],
    rationale: detail?.rationale ?? "",
    experiment_arm: detail?.experimentArm ?? null,
    policy_version: detail?.policyVersion ?? null,
  };
}
