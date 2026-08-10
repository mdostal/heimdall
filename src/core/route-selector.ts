import { randomUUID } from "node:crypto";
import type { LaneRegistry } from "./lane-registry.js";
import type { StateStore } from "./state-store.js";
import { assignExperimentArm } from "./routing/experiment-assigner.js";
import type { CostPreference, Policy } from "./routing/policy-loader.js";
import { generateRationale } from "./routing/rationale-generator.js";
import type { RouteLedger } from "./routing/route-ledger.js";
import {
  rankCandidates,
  scoreCandidate,
  type CandidateScore,
  type LaneHealth,
  type Policy as ScoringPolicy,
} from "./routing/scorer.js";

export const TASK_TYPES = ["planning", "build", "review"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export interface AvailableRoute {
  runtime: string;
  model: string;
  "token-ref": string;
  lane_id: string;
  task_type: TaskType;
  headroom: true;
}

const RUNTIME_PRIORITY: Record<TaskType, readonly string[]> = {
  planning: ["claude", "gemini", "codex", "kimi"],
  build: ["codex", "claude", "gemini", "kimi"],
  review: ["claude", "codex", "gemini", "kimi"],
};

export function parseTaskType(value: string | null): TaskType | null {
  return TASK_TYPES.find((taskType) => taskType === value) ?? null;
}

function runtimeRank(taskType: TaskType, runtime: string): number {
  const rank = RUNTIME_PRIORITY[taskType].indexOf(runtime);
  return rank === -1 ? RUNTIME_PRIORITY[taskType].length : rank;
}

export function getLaneHealths(
  registry: LaneRegistry,
  store: StateStore,
): LaneHealth[] {
  const statuses = new Map(store.getAllCurrentStatuses().map((status) => [status.lane_id, status]));
  return registry
    .list()
    .filter((lane) => lane.credential !== null)
    .filter((lane) => statuses.get(lane.lane_id)?.status === "up")
    .map((lane) => ({
      lane_id: lane.lane_id,
      provider: lane.provider,
      headroom: 10000, // Stub for now, real headroom tracking lands later
      cost_tier: "medium", // Stub for now
    }));
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
    .filter((lane) => statuses.get(lane.lane_id)?.status === "up")
    .sort((a, b) => {
      const runtimeDelta = runtimeRank(taskType, a.provider) - runtimeRank(taskType, b.provider);
      return runtimeDelta === 0 ? a.lane_id.localeCompare(b.lane_id) : runtimeDelta;
    });

  const lane = candidates[0];
  if (!lane) return null;

  return {
    runtime: lane.provider,
    model: lane.model,
    "token-ref": lane.credential_ref,
    lane_id: lane.lane_id,
    task_type: taskType,
    headroom: true,
  };
}

// --- Scored routing (rs-05): RouteSelector.select() ---------------------
//
// Distinct from getAvailableRoute() above: getAvailableRoute() answers "is
// any lane up?" from LaneRegistry/StateStore for the /available-route
// endpoint. select() answers "which lane scores best?" from a policy-driven
// heuristic over caller-supplied LaneHealth (headroom, cost tier), wiring in
// A/B assignment, rationale generation, and the RouteLedger audit trail.
// getAvailableRoute() keeps its existing callers (src/api/http-server.ts);
// this is an additive API, not a replacement.

export interface RouteRequest {
  task_id: string;
  task_type: TaskType;
  estimated_cost?: number;
}

export interface RouteResult {
  decision_id: string;
  chosen_lane: string | null;
  ranked_candidates: CandidateScore[];
  rationale: string;
  experiment_arm: string | null;
  policy_version: string;
}

export interface RouteSelectorOptions {
  now?: () => Date;
  /** Injectable for deterministic tests; defaults to node:crypto randomUUID. */
  generateDecisionId?: () => string;
}

// scorer.ts's cost_preference vocabulary predates PolicyLoader's and was
// never reconciled with it (COST_PREFERENCES in policy-loader.ts is
// "quality"/"balanced"/"economy"; scorer.ts checks "performance"/"cost").
// Bridge here rather than changing either module's already-tested behavior.
const COST_PREFERENCE_TO_SCORER: Record<CostPreference, ScoringPolicy["cost_preference"]> = {
  quality: "performance",
  balanced: "balanced",
  economy: "cost",
};

export class RouteSelector {
  private readonly policy: Policy;
  private readonly ledger: RouteLedger;
  private readonly now: () => Date;
  private readonly generateDecisionId: () => string;

  constructor(policy: Policy, ledger: RouteLedger, options: RouteSelectorOptions = {}) {
    this.policy = policy;
    this.ledger = ledger;
    this.now = options.now ?? (() => new Date());
    this.generateDecisionId = options.generateDecisionId ?? randomUUID;
  }

  select(request: RouteRequest, laneHealth: readonly LaneHealth[]): RouteResult {
    const decisionId = this.generateDecisionId();
    const experimentArm = this.policy.experiments.enabled
      ? assignExperimentArm(request.task_id, this.policy.experiments)
      : null;

    const scoringPolicy: ScoringPolicy = {
      task_type_weights: this.policy.task_type_weights,
      headroom_floor: this.policy.headroom_floor,
      cost_preference: COST_PREFERENCE_TO_SCORER[this.policy.cost_preference],
    };

    const headroomByLane = new Map(laneHealth.map((lane) => [lane.lane_id, lane.headroom]));
    const ranked = rankCandidates(
      laneHealth.map((lane) => scoreCandidate(lane, { task_type: request.task_type }, scoringPolicy)),
    );
    const chosen =
      ranked.find((candidate) => (headroomByLane.get(candidate.lane_id) ?? -Infinity) >= this.policy.headroom_floor) ??
      null;

    const rationale = chosen
      ? generateRationale(chosen, ranked)
      : "No candidate lane meets the headroom floor; no route chosen.";

    const result: RouteResult = {
      decision_id: decisionId,
      chosen_lane: chosen?.lane_id ?? null,
      ranked_candidates: ranked,
      rationale,
      experiment_arm: experimentArm,
      policy_version: this.policy.version,
    };

    try {
      this.ledger.recordDecision({
        decisionId,
        requestSummary: { task_type: request.task_type, estimated_cost: request.estimated_cost },
        candidateScores: ranked,
        result: chosen ? "lane" : "no_route",
        chosenLane: chosen?.lane_id ?? null,
        policyVersion: this.policy.version,
        heuristic: "weighted_scoring",
        experimentArm,
        recordedAt: this.now().toISOString(),
      });
    } catch (error) {
      // Design decision (rs-05): routing is critical-path — losing the audit
      // record is bad, but blocking a route decision on ledger I/O is worse.
      console.error(`RouteSelector: failed to record decision ${decisionId} to ledger`, error);
    }

    return result;
  }
}
