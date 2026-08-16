// The "scored" routing strategy (hdl-rr-03) — implements the widened
// RoutingStrategy interface (hdl-rr-02) around dev's originally-standalone
// RouteSelector.select() glue (weighted candidate scoring + deterministic
// A/B experiment arms + generated rationale + a decision ledger). Ported
// unchanged: scorer.ts, policy-loader.ts, experiment-assigner.ts,
// rationale-generator.ts, route-ledger.ts.
//
// Policy and RouteLedger are constructed lazily and held for the instance's
// lifetime — mirrors RoundRobinStrategy's module-level-singleton precedent
// (registry.ts creates one strategy instance per process, so this only
// loads the policy file / opens the ledger DB connection once).

import { randomUUID } from "node:crypto";
import type { Lane } from "../lane-registry.js";
import { assignExperimentArm } from "../routing/experiment-assigner.js";
import { PolicyLoader, type CostPreference, type Policy } from "../routing/policy-loader.js";
import { generateRationale } from "../routing/rationale-generator.js";
import { RouteLedger } from "../routing/route-ledger.js";
import {
  rankCandidates,
  scoreCandidate,
  type LaneHealth,
  type Policy as ScoringPolicy,
} from "../routing/scorer.js";
import type { RouteSelectionContext, RouteSelectionResult, RoutingStrategy } from "./types.js";

// scorer.ts's cost_preference vocabulary predates PolicyLoader's and was
// never reconciled with it (COST_PREFERENCES in policy-loader.ts is
// "quality"/"balanced"/"economy"; scorer.ts checks "performance"/"cost").
// Bridged here rather than changing either already-tested module — carried
// forward from dev's original RouteSelector class unchanged.
const COST_PREFERENCE_TO_SCORER: Record<CostPreference, ScoringPolicy["cost_preference"]> = {
  quality: "performance",
  balanced: "balanced",
  economy: "cost",
};

export interface ScoredStrategyOptions {
  policyPath?: string;
  ledgerPath?: string;
  now?: () => Date;
  generateDecisionId?: () => string;
}

function toLaneHealth(lane: Lane): LaneHealth {
  return {
    lane_id: lane.lane_id,
    provider: lane.provider,
    headroom: lane.headroom,
    cost_tier: lane.cost_tier,
  };
}

export class ScoredStrategy implements RoutingStrategy {
  readonly name = "scored";

  private readonly options: ScoredStrategyOptions;
  private policy: Policy | null = null;
  private ledger: RouteLedger | null = null;

  constructor(options: ScoredStrategyOptions = {}) {
    this.options = options;
  }

  private getPolicy(): Policy {
    if (!this.policy) this.policy = PolicyLoader.load(this.options.policyPath);
    return this.policy;
  }

  private getLedger(): RouteLedger {
    if (!this.ledger) {
      this.ledger = new RouteLedger(this.options.ledgerPath ?? process.env.HEIMDALL_DB_PATH ?? ":memory:");
    }
    return this.ledger;
  }

  /** hdl-ot-03: exposes the same ledger connection selectRoute() already writes to — GET /metrics reads through this, no second connection opened. */
  getDecisionCounts(): ReturnType<RouteLedger["getDecisionCounts"]> {
    return this.getLedger().getDecisionCounts();
  }

  /** hdl-rof-01: same connection reuse as getDecisionCounts() — reportOutcome() writes to the exact ledger row selectRoute() created. */
  reportOutcome(input: Parameters<RouteLedger["reportOutcome"]>[0]): boolean {
    return this.getLedger().reportOutcome(input);
  }

  selectRoute({ taskType, candidates, taskId }: RouteSelectionContext): RouteSelectionResult {
    const policy = this.getPolicy();
    const now = this.options.now ?? (() => new Date());
    const generateDecisionId = this.options.generateDecisionId ?? randomUUID;

    const decisionId = generateDecisionId();
    const experimentArm = policy.experiments.enabled
      ? assignExperimentArm(taskId ?? randomUUID(), policy.experiments)
      : null;

    const scoringPolicy: ScoringPolicy = {
      task_type_weights: policy.task_type_weights,
      headroom_floor: policy.headroom_floor,
      cost_preference: COST_PREFERENCE_TO_SCORER[policy.cost_preference],
    };

    const lanesById = new Map(candidates.map((lane) => [lane.lane_id, lane]));
    const laneHealth = candidates.map(toLaneHealth);
    const ranked = rankCandidates(laneHealth.map((lane) => scoreCandidate(lane, { task_type: taskType }, scoringPolicy)));
    const chosenScore =
      ranked.find((candidate) => (lanesById.get(candidate.lane_id)?.headroom ?? -Infinity) >= policy.headroom_floor) ??
      null;
    const chosenLane = chosenScore ? (lanesById.get(chosenScore.lane_id) ?? null) : null;

    const rationale = chosenScore
      ? generateRationale(chosenScore, ranked)
      : `No candidate lane meets the headroom floor (${policy.headroom_floor}); no route chosen.`;

    try {
      this.getLedger().recordDecision({
        decisionId,
        requestSummary: { task_type: taskType },
        candidateScores: ranked,
        result: chosenScore ? "lane" : "no_route",
        chosenLane: chosenScore?.lane_id ?? null,
        policyVersion: policy.version,
        heuristic: "weighted_scoring",
        experimentArm,
        recordedAt: now().toISOString(),
      });
    } catch (error) {
      // hdl-rr-03 (carried from dev's rs-05 design decision): routing is
      // critical-path — losing the audit record is bad, but blocking a
      // route decision on ledger I/O is worse.
      console.error(`ScoredStrategy: failed to record decision ${decisionId} to ledger`, error);
    }

    return {
      lane: chosenLane,
      detail: {
        rationale,
        decisionId,
        experimentArm: experimentArm ?? undefined,
        rankedCandidates: ranked.map((candidate) => ({ laneId: candidate.lane_id, score: candidate.score })),
        policyVersion: policy.version,
      },
    };
  }
}
