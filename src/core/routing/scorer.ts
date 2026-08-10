export interface Policy {
  task_type_weights: Record<string, Record<string, number>>;
  headroom_floor: number;
  cost_preference?: "cost" | "balanced" | "performance";
}

export interface LaneHealth {
  lane_id: string;
  provider: string;
  headroom: number;
  cost_tier?: "low" | "medium" | "high";
}

export interface RouteRequest {
  task_type: string;
}

export interface CandidateScore {
  lane_id: string;
  score: number;
  reasons: string[];
}

export function scoreCandidate(
  lane: LaneHealth,
  request: RouteRequest,
  policy: Policy,
): CandidateScore {
  let score = 0;
  const reasons: string[] = [];

  // Task-type weight
  const weight =
    policy.task_type_weights[request.task_type]?.[lane.provider] ?? 0;
  if (weight !== 0) {
    score += weight;
  }
  reasons.push(`task_type_weight(${lane.provider})=${weight}`);

  // Headroom penalty
  if (lane.headroom < policy.headroom_floor) {
    score -= 50;
    reasons.push(
      `headroom_penalty(${lane.headroom} < ${policy.headroom_floor})`,
    );
  }

  // Cost tier adjustment (simple version for the test)
  if (lane.cost_tier && policy.cost_preference) {
    if (policy.cost_preference === "cost" && lane.cost_tier === "high") {
      score -= 20;
      reasons.push(`cost_tier_penalty(${lane.cost_tier})=-20`);
    } else if (
      policy.cost_preference === "performance" &&
      lane.cost_tier === "low"
    ) {
      score -= 10;
      reasons.push(`cost_tier_penalty(${lane.cost_tier})=-10`);
    }
  }

  return {
    lane_id: lane.lane_id,
    score,
    reasons,
  };
}

export function rankCandidates(scores: CandidateScore[]): CandidateScore[] {
  return [...scores].sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score; // Higher score first
    }
    return a.lane_id.localeCompare(b.lane_id);
  });
}
