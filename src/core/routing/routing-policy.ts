export type TrustTier = "high" | "standard" | "cheap";

export interface LanePolicyMetadata {
  capabilities: string[];
  cost_weight: number;
  trust_tier: TrustTier;
  headroom_limits?: {
    max_concurrent_requests?: number;
    max_tokens_per_minute?: number;
  };
}

export interface HeuristicVariant {
  id: string;
  description: string;
}

export interface ExperimentDefinition {
  id: string;
  description: string;
  arms: string[];
  traffic_split: Record<string, number>;
}

export interface DegradedFallbackRule {
  from_capabilities: string[];
  to_capabilities: string[];
}

export interface RoutingPolicyConfig {
  version: string;
  lanes: Record<string, LanePolicyMetadata>;
  degraded_fallback: DegradedFallbackRule[];
  heuristic_variants: HeuristicVariant[];
  experiments: ExperimentDefinition[];
  allowed_task_tiers?: Record<string, TrustTier[]>;
}

export interface PolicyValidationResult {
  valid: boolean;
  errors: string[];
  policy: RoutingPolicyConfig | null;
}

// In-memory cache of the last known good policy
let lastKnownGoodPolicy: RoutingPolicyConfig | null = null;

export function validateRoutingPolicy(raw: unknown): PolicyValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    errors.push("Policy must be an object");
    return { valid: false, errors, policy: lastKnownGoodPolicy };
  }

  const config = raw as Record<string, unknown>;

  if (typeof config.version !== "string") {
    errors.push("Missing or invalid policy version");
  }

  const validTrustTiers = ["high", "standard", "cheap"];

  if (!config.lanes || typeof config.lanes !== "object") {
    errors.push("Missing or invalid lanes configuration");
  } else {
    for (const [laneId, laneData] of Object.entries(config.lanes)) {
      if (!laneData || typeof laneData !== "object") {
        errors.push(`Lane ${laneId} must be an object`);
        continue;
      }
      const data = laneData as Record<string, unknown>;
      
      if (!Array.isArray(data.capabilities)) {
        errors.push(`Lane ${laneId} missing capabilities array`);
      } else {
        if (!data.capabilities.every(c => typeof c === "string")) {
          errors.push(`Lane ${laneId} capabilities must be strings`);
        }
      }
      
      if (typeof data.cost_weight !== "number") {
        errors.push(`Lane ${laneId} missing or invalid cost_weight`);
      }
      
      if (typeof data.trust_tier !== "string" || !validTrustTiers.includes(data.trust_tier)) {
        errors.push(`Lane ${laneId} has invalid trust_tier`);
      }
      
      if (data.headroom_limits !== undefined) {
        if (typeof data.headroom_limits !== "object" || data.headroom_limits === null) {
          errors.push(`Lane ${laneId} headroom_limits must be an object`);
        } else {
          const hl = data.headroom_limits as Record<string, unknown>;
          if (hl.max_concurrent_requests !== undefined && typeof hl.max_concurrent_requests !== "number") {
            errors.push(`Lane ${laneId} max_concurrent_requests must be a number`);
          }
          if (hl.max_tokens_per_minute !== undefined && typeof hl.max_tokens_per_minute !== "number") {
            errors.push(`Lane ${laneId} max_tokens_per_minute must be a number`);
          }
        }
      }
    }
  }
  
  if (config.allowed_task_tiers !== undefined) {
    if (typeof config.allowed_task_tiers !== "object" || config.allowed_task_tiers === null) {
      errors.push("allowed_task_tiers must be an object");
    } else {
      for (const [taskType, tiers] of Object.entries(config.allowed_task_tiers)) {
        if (!Array.isArray(tiers)) {
          errors.push(`allowed_task_tiers for ${taskType} must be an array of trust tiers`);
        } else {
          for (const tier of tiers) {
            if (!validTrustTiers.includes(tier as string)) {
               errors.push(`allowed_task_tiers for ${taskType} contains invalid trust tier: ${tier}`);
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, policy: lastKnownGoodPolicy };
  }

  // Assuming it's fully well-formed for basic requirements, build and save the known good config
  const validPolicy: RoutingPolicyConfig = {
    version: config.version as string,
    lanes: config.lanes as Record<string, LanePolicyMetadata>,
    degraded_fallback: Array.isArray(config.degraded_fallback) ? config.degraded_fallback : [],
    heuristic_variants: Array.isArray(config.heuristic_variants) ? config.heuristic_variants : [],
    experiments: Array.isArray(config.experiments) ? config.experiments : [],
    allowed_task_tiers: typeof config.allowed_task_tiers === "object" ? config.allowed_task_tiers as Record<string, TrustTier[]> : undefined,
  };

  lastKnownGoodPolicy = validPolicy;

  return {
    valid: true,
    errors: [],
    policy: validPolicy
  };
}

export function getLastKnownGoodPolicy(): RoutingPolicyConfig | null {
  return lastKnownGoodPolicy;
}

export function resetLastKnownGoodPolicyForTesting(): void {
  lastKnownGoodPolicy = null;
}
