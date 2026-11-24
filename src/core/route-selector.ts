import { existsSync } from "node:fs";
import type { Lane, LaneRegistry } from "./lane-registry.js";
import type { StateStore } from "./state-store.js";
import { createRoutingStrategyRegistry, DEFAULT_ROUTING_STRATEGY_NAME } from "./routing-strategies/registry.js";
import { ScoredStrategy } from "./routing-strategies/scored-strategy.js";
import { resolveEffectiveModel } from "./model-catalog.js";
import { TASK_TYPES, type TaskType, parseTaskType } from "./task-type.js";
import type { JsonValue } from "./routing/route-ledger.js";
import type { RouteSelectionDetail } from "./routing-strategies/types.js";
import { DEFAULT_POLICY_PATH, PolicyLoader, PolicyValidationError } from "./routing/policy-loader.js";
import {
  allowedLevels,
  LevelConfigError,
  resolveLevel,
  validateLaneTiers,
  type Level,
  type LevelPolicy,
} from "./routing/levels.js";
import { getModelUsability } from "./lane-models.js";

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
  /** heimdall#123 — lanes the policy's excluded_lanes withheld from this
   * decision; present only when at least one was withheld. */
  excluded_lanes?: readonly string[];
  /** heimdall#142 slice 3 — present only when the policy configures levels:
   * the routed model's level, the work class it was judged under, the
   * levels that class allows, and any lane withheld by the level gate. */
  level?: Level;
  work_class?: string;
  allowed_levels?: readonly Level[];
  level_withheld?: readonly LevelWithheldLane[];
}

/** heimdall#142 slice 3 — why the level gate withheld a lane. */
export type LevelWithheldReason =
  /** The routed model's level isn't one the work class allows (e.g. standard for build). */
  | "level_not_allowed"
  /** No config binds the routed model to a level; unbound is never treated as premium. */
  | "unbound"
  /** The operator turned the routed model off (slice 2 toggle). */
  | "model_disabled"
  /** An exhausted limit blocks the routed model (slice 1 limits). */
  | "model_unavailable";

export interface LevelWithheldLane {
  lane_id: string;
  model: string;
  level: Level | null;
  reason: LevelWithheldReason;
  /** When the blocking limits reset, for model_unavailable; else null. */
  available_at: string | null;
}

/** heimdall#142 slice 3 — the level gate a decision ran under. */
export interface LevelGate {
  work_class: string;
  allowed_levels: readonly Level[];
  /** True when the premium floor for code work applies. */
  floor: boolean;
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

// heimdall#123: the policy file is also where lane exclusions live, and they
// apply under every strategy, not only "scored". Held here rather than read
// through a ScoredStrategy so priority/round-robin routing needs no scored
// instance. Cached after the first good load, like ScoredStrategy's own
// policy; useRoutePolicyPath() resets it.
let routePolicyPath: string | undefined;
// heimdall#142 slice 3: the level bindings live in the same file and are
// cached alongside the exclusions.
interface RoutePolicyFilters {
  excluded: ReadonlySet<string>;
  levels: LevelPolicy | null;
}
let cachedFilters: RoutePolicyFilters | null = null;

// No policy file means no exclusions were configured, so routing proceeds
// exactly as before this existed (priority/round-robin never needed the
// file). A file that exists but doesn't validate throws
// PolicyValidationError: the operator's exclusions can't be read, so every
// strategy fails closed (503) instead of possibly routing to an excluded
// lane.
// The same holds for levels: no file means no level routing, and an invalid
// `levels` / `work_classes` section fails closed.
function getRoutePolicyFilters(): RoutePolicyFilters {
  if (cachedFilters) return cachedFilters;
  const path = routePolicyPath ?? DEFAULT_POLICY_PATH;
  if (!existsSync(path)) return { excluded: new Set(), levels: null };
  const policy = PolicyLoader.load(path);
  cachedFilters = { excluded: new Set(policy.excluded_lanes), levels: policy.levels };
  return cachedFilters;
}

interface RoutingCandidates {
  candidates: Lane[];
  /** Lanes that passed every other filter but are in the policy's excluded_lanes. */
  excludedLanes: string[];
  /** null when the policy configures no levels. */
  levelGate: LevelGate | null;
  /** Lanes that passed every other filter but the level gate withheld. */
  levelWithheld: LevelWithheldLane[];
  /** Level of each candidate's routed model (only when levelGate is set). */
  candidateLevels: Map<string, Level>;
  /** Earliest time a lane at an allowed level could become routable, when any reported one. */
  queueResetsAt: string | null;
}

export interface RouteOptions {
  /** heimdall#142 slice 3 — the work class to judge levels under; defaults to the task type. */
  workClass?: string;
  now?: Date;
}

// hdl-rr-03: shared candidacy filtering — used by both getAvailableRoute
// (active-strategy-driven) and getScoredRoute (always-scored, bypasses the
// active-strategy setting). One definition of "which lanes are even
// eligible to be routed to" for every routing surface.
function getRoutingCandidates(
  registry: LaneRegistry,
  store: StateStore,
  taskType: TaskType,
  options: RouteOptions = {},
): RoutingCandidates {
  for (const lane of registry.list()) {
    store.upsertLane({
      lane_id: lane.lane_id,
      provider: lane.provider,
      credential_ref: lane.credential_ref,
    });
  }

  const statuses = new Map(store.getAllCurrentStatuses().map((status) => [status.lane_id, status]));
  // hdl-rs-01: manual_override gates routing candidacy the SAME way it
  // already gates Multica actuation (MulticaControlAdapter.reconcile) —
  // "disabled" blocks a lane from being routed to no matter its sensed
  // status; "enabled" forces it in even if sensed status isn't "up";
  // unset (null) is byte-identical to pre-hdl-rs-01 behavior.
  const statusAllows = (lane: Lane): boolean => {
    const override = store.getManualOverride(lane.lane_id);
    if (override === "disabled") return false;
    if (override === "enabled") return true;
    return statuses.get(lane.lane_id)?.status === "up";
  };
  const credentialed = registry.list().filter((lane) => lane.credential !== null);
  const eligible = credentialed.filter(statusAllows);

  // heimdall#123: applied after status, so it wins over a manual "enabled"
  // override too — an excluded lane is never a candidate, and a decision
  // with no other candidate is "no route", never a fallback to the excluded
  // lane.
  const { excluded, levels } = getRoutePolicyFilters();
  const notExcluded = eligible.filter((lane) => !excluded.has(lane.lane_id));
  const excludedLanes = eligible.filter((lane) => excluded.has(lane.lane_id)).map((lane) => lane.lane_id);
  if (!levels) {
    return { candidates: notExcluded, excludedLanes, levelGate: null, levelWithheld: [], candidateLevels: new Map(), queueResetsAt: null };
  }

  // heimdall#142 slice 3: the level gate, applied last, so like
  // excluded_lanes it wins over a manual "enabled" override. A lane is a
  // candidate only when the model it would route (after any catalog
  // substitution) is bound to a level the work class allows, is switched on
  // and isn't blocked by an exhausted limit. A decision left with no
  // candidate is a queue, never a step down to a lower level.
  try {
    validateLaneTiers(registry.list());
  } catch (error) {
    if (error instanceof LevelConfigError) throw new PolicyValidationError(error.message);
    throw error;
  }
  const now = options.now ?? new Date();
  const gate = allowedLevels(levels, taskType, options.workClass);
  const levelGate: LevelGate = { work_class: gate.work_class, allowed_levels: gate.levels, floor: gate.floor };
  const candidates: Lane[] = [];
  const levelWithheld: LevelWithheldLane[] = [];
  const candidateLevels = new Map<string, Level>();
  let queueResetsAt: string | null = null;
  const noteReset = (at: string | null): void => {
    if (at !== null && Date.parse(at) > now.getTime() && (queueResetsAt === null || Date.parse(at) < Date.parse(queueResetsAt))) {
      queueResetsAt = at;
    }
  };

  for (const lane of credentialed) {
    if (excluded.has(lane.lane_id) || store.getManualOverride(lane.lane_id) === "disabled") continue;
    const routable = statusAllows(lane);
    const { model } = resolveEffectiveModel(store, lane.provider, lane.model);
    const { level } = resolveLevel(levels, lane, model);
    const withhold = (reason: LevelWithheldReason, availableAt: string | null = null): void => {
      if (routable) levelWithheld.push({ lane_id: lane.lane_id, model, level, reason, available_at: availableAt });
    };
    if (level === null) {
      withhold("unbound");
      continue;
    }
    if (!gate.levels.includes(level)) {
      withhold("level_not_allowed");
      continue;
    }
    const usability = getModelUsability(lane, model, store, now);
    if (!usability.enabled) {
      withhold("model_disabled");
      continue;
    }
    if (!usability.available) {
      noteReset(usability.available_at);
      withhold("model_unavailable", usability.available_at);
      continue;
    }
    if (!routable) {
      noteReset(store.getManualResetAt(lane.lane_id) ?? statuses.get(lane.lane_id)?.reset_at ?? null);
      continue;
    }
    candidates.push(lane);
    candidateLevels.set(lane.lane_id, level);
  }

  return { candidates, excludedLanes, levelGate, levelWithheld, candidateLevels, queueResetsAt };
}

function levelContext(routing: RoutingCandidates) {
  return routing.levelGate
    ? {
        levelGate: { ...routing.levelGate, resets_at: routing.queueResetsAt },
        levelWithheld: routing.levelWithheld.map(({ lane_id, reason }) => ({ lane_id, reason })),
      }
    : {};
}

/**
 * heimdall#142 slice 3 — what GET /available-route answers. `queue` means the
 * level gate left no lane: every model the work class may use is unbound,
 * off, exhausted or on a lane that's down. It carries the earliest reset
 * Heimdall knows of (null when none was reported). It is never answered by
 * stepping down a level. `no_route` is everything else that picks no lane
 * (no healthy lane at all, the "off" strategy, the scored headroom floor).
 */
export type RouteVerdict =
  | { verdict: "route"; route: AvailableRoute }
  | {
      verdict: "queue";
      task_type: TaskType;
      work_class: string;
      allowed_levels: readonly Level[];
      resets_at: string | null;
      level_withheld: readonly LevelWithheldLane[];
      excluded_lanes: readonly string[];
    }
  | { verdict: "no_route"; task_type: TaskType };

function isQueue(routing: RoutingCandidates): boolean {
  return routing.levelGate !== null && routing.candidates.length === 0;
}

export function getRouteVerdict(
  taskType: TaskType,
  registry: LaneRegistry,
  store: StateStore,
  options: RouteOptions = {},
): RouteVerdict {
  const routing = getRoutingCandidates(registry, store, taskType, options);
  const { candidates, excludedLanes, levelGate, levelWithheld } = routing;
  if (isQueue(routing)) {
    // No strategy runs: there is nothing at an allowed level to pick from,
    // and "off" declining to pick must not read as a queue.
    return {
      verdict: "queue",
      task_type: taskType,
      work_class: levelGate!.work_class,
      allowed_levels: levelGate!.allowed_levels,
      resets_at: routing.queueResetsAt,
      level_withheld: levelWithheld,
      excluded_lanes: excludedLanes,
    };
  }

  const strategy = routingStrategies[getActiveRoutingStrategyName(store)];
  const { lane, detail } = strategy.selectRoute({ taskType, candidates, store, excludedLanes, ...levelContext(routing) });
  if (!lane) return { verdict: "no_route", task_type: taskType };
  return { verdict: "route", route: toAvailableRoute(lane, detail, taskType, store, routing) };
}

/** The route GET /available-route returns, or null for a queue or no route (see getRouteVerdict for which). */
export function getAvailableRoute(
  taskType: TaskType,
  registry: LaneRegistry,
  store: StateStore,
  options: RouteOptions = {},
): AvailableRoute | null {
  const verdict = getRouteVerdict(taskType, registry, store, options);
  return verdict.verdict === "route" ? verdict.route : null;
}

function toAvailableRoute(
  lane: Lane,
  detail: RouteSelectionDetail | undefined,
  taskType: TaskType,
  store: StateStore,
  routing: RoutingCandidates,
): AvailableRoute {
  const { excludedLanes, levelGate, levelWithheld, candidateLevels } = routing;
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
    ...(excludedLanes.length > 0 ? { excluded_lanes: excludedLanes } : {}),
    ...(levelGate
      ? {
          level: candidateLevels.get(lane.lane_id)!,
          work_class: levelGate.work_class,
          allowed_levels: levelGate.allowed_levels,
          ...(levelWithheld.length > 0 ? { level_withheld: levelWithheld } : {}),
        }
      : {}),
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
  /** heimdall#142 slice 3 — the work class to judge levels under; defaults to task_type. */
  work_class?: string;
}

export interface RouteResult {
  decision_id: string | null;
  chosen_lane: string | null;
  ranked_candidates: ReadonlyArray<{ laneId: string; score: number }>;
  rationale: string;
  experiment_arm: string | null;
  policy_version: string | null;
  /** heimdall#123 — lanes withheld by the policy's excluded_lanes ([] when none). */
  excluded_lanes: readonly string[];
  /** heimdall#142 slice 3 — "queue" when the level gate left no lane (see RouteVerdict). */
  verdict: "route" | "queue" | "no_route";
  /** For a queue: the earliest reset Heimdall knows of for an allowed-level model; else null. */
  resets_at: string | null;
  /** The work class and levels the decision was judged under; null when the policy configures no levels. */
  work_class: string | null;
  allowed_levels: readonly Level[] | null;
  /** The chosen lane's routed-model level; null with no lane or no level config. */
  chosen_level: Level | null;
  /** Lanes withheld by the level gate ([] when none). */
  level_withheld: readonly LevelWithheldLane[];
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

// heimdall#96: the routing strategies that write decisions to a ledger.
// Both go through one path so every routing surface in a process shares the
// file composeService() binds.
const ledgerBackedStrategies: ScoredStrategy[] = [
  scoredStrategyForRouteEndpoint,
  ...Object.values(routingStrategies).filter((strategy): strategy is ScoredStrategy => strategy instanceof ScoredStrategy),
];

/** Points every ledger-backed strategy at `path` — composeService() passes its StateStore's DB path. */
export function useRouteLedgerPath(path: string): void {
  for (const strategy of ledgerBackedStrategies) strategy.useLedgerPath(path);
}

/** Points every scored strategy, and the excluded_lanes filter, at the routing policy in `path` (undefined = the default path). Tests use it to simulate a missing policy (heimdall#95). */
export function useRoutePolicyPath(path: string | undefined): void {
  routePolicyPath = path;
  cachedFilters = null;
  for (const strategy of ledgerBackedStrategies) strategy.usePolicyPath(path);
}

export function closeRouteLedgers(): void {
  for (const strategy of ledgerBackedStrategies) strategy.closeLedger();
}

export interface RouteOutcomeEvent {
  decisionId: string;
  laneId: string;
  outcome: string | null;
  metadata: Record<string, JsonValue> | null;
}

export type RouteOutcomeListener = (event: RouteOutcomeEvent) => void;

const routeOutcomeListeners = new Set<RouteOutcomeListener>();

/** heimdall#96: composeService() listens here to feed outcomes to lane status. Returns an unsubscribe function. */
export function onRouteOutcome(listener: RouteOutcomeListener): () => void {
  routeOutcomeListeners.add(listener);
  return () => routeOutcomeListeners.delete(listener);
}

export interface RouteOutcomeInput {
  decisionId: string;
  outcome?: string;
  actualCost?: number;
  metadata?: Record<string, JsonValue>;
}

export type ReportRouteOutcomeResult = { ok: true } | { ok: false; error: "unknown_decision" };

// hdl-rof-01: closes the loop RouteLedger was always designed for — a
// caller that got a decision_id from getScoredRoute() reports back what
// actually happened. Reuses the exact same ledger connection getScoredRoute()
// wrote the original decision to.
export function reportRouteOutcome(input: RouteOutcomeInput): ReportRouteOutcomeResult {
  const recorded = scoredStrategyForRouteEndpoint.reportOutcome({
    decisionId: input.decisionId,
    outcome: input.outcome ?? null,
    actualCost: input.actualCost ?? null,
    metadata: input.metadata ?? null,
  });
  if (!recorded) return { ok: false, error: "unknown_decision" };

  const laneId = routeOutcomeListeners.size > 0 ? scoredStrategyForRouteEndpoint.getChosenLane(input.decisionId) : null;
  if (laneId) {
    const event: RouteOutcomeEvent = {
      decisionId: input.decisionId,
      laneId,
      outcome: input.outcome ?? null,
      metadata: input.metadata ?? null,
    };
    for (const listener of routeOutcomeListeners) {
      try {
        listener(event);
      } catch (error) {
        // The outcome is already in the ledger; a listener failure must not
        // turn a recorded outcome into an error response.
        console.error(`reportRouteOutcome: outcome listener failed for decision ${input.decisionId}`, error);
      }
    }
  }
  return { ok: true };
}

export function getScoredRoute(
  request: RouteRequest,
  registry: LaneRegistry,
  store: StateStore,
  options: Omit<RouteOptions, "workClass"> = {},
): RouteResult {
  const routing = getRoutingCandidates(registry, store, request.task_type, { ...options, workClass: request.work_class });
  const { candidates, excludedLanes, levelGate, levelWithheld, candidateLevels } = routing;
  // The scored strategy still runs on a queue, so the decision (and why no
  // lane was chosen) is in the ledger like every other no-route decision.
  const { lane, detail } = scoredStrategyForRouteEndpoint.selectRoute({
    taskType: request.task_type,
    candidates,
    store,
    taskId: request.task_id,
    excludedLanes,
    ...levelContext(routing),
  });
  const queued = isQueue(routing);

  return {
    decision_id: detail?.decisionId ?? null,
    chosen_lane: lane?.lane_id ?? null,
    ranked_candidates: detail?.rankedCandidates ?? [],
    rationale: detail?.rationale ?? "",
    experiment_arm: detail?.experimentArm ?? null,
    policy_version: detail?.policyVersion ?? null,
    excluded_lanes: excludedLanes,
    verdict: lane ? "route" : queued ? "queue" : "no_route",
    resets_at: queued ? routing.queueResetsAt : null,
    work_class: levelGate?.work_class ?? null,
    allowed_levels: levelGate?.allowed_levels ?? null,
    chosen_level: lane ? (candidateLevels.get(lane.lane_id) ?? null) : null,
    level_withheld: levelWithheld,
  };
}
