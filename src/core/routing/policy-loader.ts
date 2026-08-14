import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { TASK_TYPES, type TaskType } from "../task-type.js";

export const DEFAULT_POLICY_PATH = join(process.cwd(), "config", "routing-policy.yaml");
export const POLICY_SCHEMA_VERSION = "1.0";
export const COST_PREFERENCES = ["quality", "balanced", "economy"] as const;

export type CostPreference = (typeof COST_PREFERENCES)[number];

export interface ExperimentArm {
  split: number;
}

export interface PolicyExperiments {
  enabled: boolean;
  arms: Record<string, ExperimentArm>;
}

export interface Policy {
  version: typeof POLICY_SCHEMA_VERSION;
  task_type_weights: Record<TaskType, Record<string, number>>;
  headroom_floor: number;
  cost_preference: CostPreference;
  experiments: PolicyExperiments;
}

export class PolicyLoader {
  static load(path: string = DEFAULT_POLICY_PATH): Policy {
    let parsed: unknown;

    try {
      const document = parseDocument(readFileSync(path, "utf8"), { prettyErrors: false });
      if (document.errors.length > 0) {
        throw new PolicyValidationError(`Invalid YAML: ${document.errors[0].message}`);
      }
      parsed = document.toJSON();
    } catch (error) {
      if (error instanceof PolicyValidationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new PolicyValidationError(`Failed to load routing policy from ${path}: ${message}`);
    }

    return validatePolicy(parsed);
  }
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

function validatePolicy(value: unknown): Policy {
  const policy = requireRecord(value, "policy");
  const version = requireString(policy, "version");
  if (version !== POLICY_SCHEMA_VERSION) {
    throw new PolicyValidationError(`Invalid field "version": expected "${POLICY_SCHEMA_VERSION}"`);
  }

  return {
    version,
    task_type_weights: validateTaskTypeWeights(requireRecord(policy.task_type_weights, "task_type_weights")),
    headroom_floor: requireNonNegativeNumber(policy, "headroom_floor"),
    cost_preference: validateCostPreference(requireString(policy, "cost_preference")),
    experiments: validateExperiments(requireRecord(policy.experiments, "experiments")),
  };
}

function validateTaskTypeWeights(value: Record<string, unknown>): Policy["task_type_weights"] {
  const weights = {} as Policy["task_type_weights"];

  for (const taskType of TASK_TYPES) {
    const providerWeights = requireRecord(value[taskType], `task_type_weights.${taskType}`);
    const entries = Object.entries(providerWeights);
    if (entries.length === 0) {
      throw new PolicyValidationError(`Invalid field "task_type_weights.${taskType}": expected at least one provider`);
    }

    weights[taskType] = {};
    for (const [provider, weight] of entries) {
      weights[taskType][provider] = requireNonNegativeNumber(providerWeights, provider, `task_type_weights.${taskType}.${provider}`);
    }
  }

  return weights;
}

function validateCostPreference(value: string): CostPreference {
  if (!isCostPreference(value)) {
    throw new PolicyValidationError(
      `Invalid field "cost_preference": expected one of ${COST_PREFERENCES.join(", ")}`,
    );
  }
  return value;
}

function validateExperiments(value: Record<string, unknown>): PolicyExperiments {
  const arms = requireRecord(value.arms, "experiments.arms");
  const entries = Object.entries(arms);
  if (entries.length === 0) {
    throw new PolicyValidationError(`Invalid field "experiments.arms": expected at least one arm`);
  }

  return {
    enabled: requireBoolean(value, "enabled", "experiments.enabled"),
    arms: Object.fromEntries(
      entries.map(([armName, armConfig]) => {
        const arm = requireRecord(armConfig, `experiments.arms.${armName}`);
        return [armName, { split: requireSplitRatio(arm, "split", `experiments.arms.${armName}.split`) }];
      }),
    ),
  };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    throw new PolicyValidationError(`Missing required field "${field}"`);
  }
  if (!isRecord(value)) {
    throw new PolicyValidationError(`Invalid field "${field}": expected object`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (value === undefined || value === null) {
    throw new PolicyValidationError(`Missing required field "${field}"`);
  }
  if (typeof value !== "string") {
    throw new PolicyValidationError(`Invalid field "${field}": expected string`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, field: string, fieldPath: string = field): boolean {
  const value = record[field];
  if (value === undefined || value === null) {
    throw new PolicyValidationError(`Missing required field "${fieldPath}"`);
  }
  if (typeof value !== "boolean") {
    throw new PolicyValidationError(`Invalid field "${fieldPath}": expected boolean`);
  }
  return value;
}

function requireNonNegativeNumber(record: Record<string, unknown>, field: string, fieldPath: string = field): number {
  const value = record[field];
  if (value === undefined || value === null) {
    throw new PolicyValidationError(`Missing required field "${fieldPath}"`);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PolicyValidationError(`Invalid field "${fieldPath}": expected nonnegative number`);
  }
  return value;
}

function requireSplitRatio(record: Record<string, unknown>, field: string, fieldPath: string): number {
  const value = requireNonNegativeNumber(record, field, fieldPath);
  if (value > 1) {
    throw new PolicyValidationError(`Invalid field "${fieldPath}": expected value between 0 and 1`);
  }
  return value;
}

function isCostPreference(value: string): value is CostPreference {
  return COST_PREFERENCES.includes(value as CostPreference);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
