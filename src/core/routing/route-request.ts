export type TaskType = "bulk" | "specialized" | "interactive";

export interface RouteRequest {
  task_type: TaskType;
  estimated_cost?: number;
  capabilities: string[];
  constraints: string[];
  experiment_subject?: string;
}

export interface CandidateScore {
  lane_id: string;
  score: number;
}

export interface RouteRecommendation {
  decision_id: string;
  chosen_route: string | null;
  policy_version: string;
  heuristic: string;
  experiment_arm?: string;
  candidate_scores: CandidateScore[];
  reasons: string[];
}

export function parseRouteRequest(raw: unknown): RouteRequest {
  const allowedTaskTypes = ["bulk", "specialized", "interactive"];
  
  if (!raw || typeof raw !== "object") {
    return {
      task_type: "interactive",
      capabilities: [],
      constraints: [],
    };
  }

  const req = raw as Record<string, unknown>;

  // Ensure we only pick explicitly defined fields and strip everything else 
  // (like prompts, credentials, etc.)
  return {
    task_type: typeof req.task_type === "string" && allowedTaskTypes.includes(req.task_type) 
      ? (req.task_type as TaskType) 
      : "interactive",
    estimated_cost: typeof req.estimated_cost === "number" ? req.estimated_cost : undefined,
    capabilities: Array.isArray(req.capabilities) 
      ? req.capabilities.filter(c => typeof c === "string")
      : [],
    constraints: Array.isArray(req.constraints)
      ? req.constraints.filter(c => typeof c === "string")
      : [],
    experiment_subject: typeof req.experiment_subject === "string" ? req.experiment_subject : undefined,
  };
}
