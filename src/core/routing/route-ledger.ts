import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routing_decisions (
  decision_id TEXT PRIMARY KEY,
  request_summary TEXT NOT NULL,
  candidate_scores TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('lane','no_route')),
  chosen_lane TEXT,
  policy_version TEXT NOT NULL,
  heuristic TEXT NOT NULL,
  experiment_arm TEXT,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routing_outcomes (
  decision_id TEXT PRIMARY KEY REFERENCES routing_decisions(decision_id) ON DELETE CASCADE,
  outcome TEXT,
  actual_cost REAL,
  metadata TEXT NOT NULL,
  reported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routing_decisions_recorded_at
  ON routing_decisions(recorded_at DESC);
`;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export interface RouteRequestSummary {
  task_type?: string;
  taskType?: string;
  estimated_cost?: number;
  estimatedCost?: number;
  capabilities?: readonly string[];
  constraints?: Record<string, unknown>;
  experiment_subject?: string | null;
  experimentSubject?: string | null;
}

export interface CandidateScore {
  lane_id: string;
  score: number;
  reasons?: readonly string[];
  components?: Record<string, JsonPrimitive>;
}

export type RouteDecisionResult = "lane" | "no_route";

export interface RecordRouteDecisionInput {
  decisionId: string;
  requestSummary: RouteRequestSummary;
  candidateScores: readonly CandidateScore[];
  result: RouteDecisionResult;
  chosenLane: string | null;
  policyVersion: string;
  heuristic: string;
  experimentArm?: string | null;
  recordedAt?: string;
}

export interface ReportRouteOutcomeInput {
  decisionId: string;
  outcome?: string | null;
  actualCost?: number | null;
  metadata?: Record<string, JsonValue> | null;
  reportedAt?: string;
}

export interface RouteDecisionEntry {
  decisionId: string;
  requestSummary: JsonObject;
  candidateScores: CandidateScore[];
  result: RouteDecisionResult;
  chosenLane: string | null;
  policyVersion: string;
  heuristic: string;
  experimentArm: string | null;
  recordedAt: string;
  outcome: RouteOutcomeEntry | null;
}

export interface RouteOutcomeEntry {
  outcome: string | null;
  actualCost: number | null;
  metadata: JsonObject;
  reportedAt: string;
}

export interface RouteLedgerOptions {
  path?: string;
  database?: DatabaseSync;
  now?: () => Date;
}

interface DecisionRow {
  decision_id: string;
  request_summary: string;
  candidate_scores: string;
  result: RouteDecisionResult;
  chosen_lane: string | null;
  policy_version: string;
  heuristic: string;
  experiment_arm: string | null;
  recorded_at: string;
  outcome: string | null;
  actual_cost: number | null;
  metadata: string | null;
  reported_at: string | null;
}

const REQUEST_SUMMARY_KEYS = new Map<string, string>([
  ["task_type", "task_type"],
  ["taskType", "task_type"],
  ["estimated_cost", "estimated_cost"],
  ["estimatedCost", "estimated_cost"],
  ["capabilities", "capabilities"],
  ["constraints", "constraints"],
  ["experiment_subject", "experiment_subject"],
  ["experimentSubject", "experiment_subject"],
]);

const SENSITIVE_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "body",
  "content",
  "credential",
  "credentials",
  "message",
  "messages",
  "password",
  "payload",
  "prompt",
  "raw_prompt",
  "secret",
  "text",
  "token",
  "tokens",
]);

export class RouteLedger {
  private readonly db: DatabaseSync;
  private readonly ownsDatabase: boolean;
  private readonly now: () => Date;

  constructor(options: string | RouteLedgerOptions = ":memory:") {
    const normalized = typeof options === "string" ? { path: options } : options;

    this.db =
      normalized.database ??
      new DatabaseSync(normalized.path ?? ":memory:", { enableForeignKeyConstraints: true });
    this.ownsDatabase = normalized.database === undefined;
    this.now = normalized.now ?? (() => new Date());
    this.db.exec(SCHEMA);
  }

  recordDecision(decision: RecordRouteDecisionInput): void {
    const recordedAt = decision.recordedAt ?? this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO routing_decisions
           (decision_id, request_summary, candidate_scores, result, chosen_lane,
            policy_version, heuristic, experiment_arm, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.decisionId,
        stringifyJson(sanitizeRequestSummary(decision.requestSummary)),
        stringifyJson(decision.candidateScores),
        decision.result,
        decision.chosenLane,
        decision.policyVersion,
        decision.heuristic,
        decision.experimentArm ?? null,
        recordedAt,
      );
  }

  reportOutcome(outcome: ReportRouteOutcomeInput): boolean {
    const existing = this.db
      .prepare(`SELECT decision_id FROM routing_decisions WHERE decision_id = ?`)
      .get(outcome.decisionId);
    if (!existing) return false;

    const reportedAt = outcome.reportedAt ?? this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO routing_outcomes
           (decision_id, outcome, actual_cost, metadata, reported_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(decision_id) DO UPDATE SET
           outcome = excluded.outcome,
           actual_cost = excluded.actual_cost,
           metadata = excluded.metadata,
           reported_at = excluded.reported_at`,
      )
      .run(
        outcome.decisionId,
        outcome.outcome ?? null,
        outcome.actualCost ?? null,
        stringifyJson(outcome.metadata ?? {}),
        reportedAt,
      );

    return true;
  }

  getDecision(decisionId: string): RouteDecisionEntry | null {
    const row = this.db
      .prepare(
        `SELECT
           d.decision_id,
           d.request_summary,
           d.candidate_scores,
           d.result,
           d.chosen_lane,
           d.policy_version,
           d.heuristic,
           d.experiment_arm,
           d.recorded_at,
           o.outcome,
           o.actual_cost,
           o.metadata,
           o.reported_at
         FROM routing_decisions d
         LEFT JOIN routing_outcomes o ON o.decision_id = d.decision_id
         WHERE d.decision_id = ?`,
      )
      .get(decisionId) as unknown as DecisionRow | undefined;

    if (!row) return null;

    return {
      decisionId: row.decision_id,
      requestSummary: parseJson(row.request_summary) as JsonObject,
      candidateScores: parseJson(row.candidate_scores) as unknown as CandidateScore[],
      result: row.result,
      chosenLane: row.chosen_lane,
      policyVersion: row.policy_version,
      heuristic: row.heuristic,
      experimentArm: row.experiment_arm,
      recordedAt: row.recorded_at,
      outcome:
        row.reported_at === null
          ? null
          : {
              outcome: row.outcome,
              actualCost: row.actual_cost,
              metadata: parseJson(row.metadata ?? "{}") as JsonObject,
              reportedAt: row.reported_at,
            },
    };
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }
}

function sanitizeRequestSummary(summary: RouteRequestSummary): JsonObject {
  const sanitized: JsonObject = {};
  for (const [key, value] of Object.entries(summary)) {
    const persistedKey = REQUEST_SUMMARY_KEYS.get(key);
    if (!persistedKey) continue;

    const sanitizedValue = sanitizeJsonValue(value);
    if (sanitizedValue !== undefined) sanitized[persistedKey] = sanitizedValue;
  }
  return sanitized;
}

function sanitizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === "object") {
    const sanitized: JsonObject = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) continue;

      const sanitizedValue = sanitizeJsonValue(nestedValue);
      if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
    }
    return sanitized;
  }
  return undefined;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replaceAll("-", "_"));
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}
