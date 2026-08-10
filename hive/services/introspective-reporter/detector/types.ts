import type { IntrospectionContext } from "../context.js";

export type FindingCategory = "stall" | "dispatch_gap" | "ship_gap" | "infra";

export type FindingSeverity = "critical" | "high" | "medium" | "low";

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  description: string;
  evidence: unknown;
  auto_recoverable: boolean;
  timestamp: Date;
}

export interface FailureDetector {
  name: string;
  detect(context: IntrospectionContext): Promise<Finding[]>;
}

export interface FindingValidationResult {
  ok: boolean;
  errors: string[];
}

const FINDING_CATEGORIES: readonly FindingCategory[] = [
  "stall",
  "dispatch_gap",
  "ship_gap",
  "infra",
];

const FINDING_SEVERITIES: readonly FindingSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateFinding(candidate: unknown): FindingValidationResult {
  const errors: string[] = [];
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, errors: ["finding must be an object"] };
  }

  const finding = candidate as Partial<Finding>;
  if (!isNonEmptyString(finding.id)) errors.push("id is required");
  if (!FINDING_CATEGORIES.includes(finding.category as FindingCategory)) {
    errors.push("category must be one of stall, dispatch_gap, ship_gap, infra");
  }
  if (!FINDING_SEVERITIES.includes(finding.severity as FindingSeverity)) {
    errors.push("severity must be one of critical, high, medium, low");
  }
  if (!isNonEmptyString(finding.title)) errors.push("title is required");
  if (!isNonEmptyString(finding.description)) errors.push("description is required");
  if (!("evidence" in finding)) errors.push("evidence is required");
  if (typeof finding.auto_recoverable !== "boolean") {
    errors.push("auto_recoverable must be boolean");
  }
  if (!(finding.timestamp instanceof Date) || Number.isNaN(finding.timestamp.getTime())) {
    errors.push("timestamp must be a valid Date");
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidFinding(candidate: unknown): asserts candidate is Finding {
  const result = validateFinding(candidate);
  if (!result.ok) {
    throw new Error(`invalid finding: ${result.errors.join("; ")}`);
  }
}
