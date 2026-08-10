import { test } from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "../state-store.js";
import { RouteLedger, type RecordRouteDecisionInput } from "./route-ledger.js";

const RECORDED_AT = "2026-08-08T12:00:00.000Z";
const REPORTED_AT = "2026-08-08T12:01:00.000Z";

function decision(overrides: Partial<RecordRouteDecisionInput> = {}): RecordRouteDecisionInput {
  return {
    decisionId: "decision-1",
    requestSummary: {
      task_type: "build",
      estimated_cost: 0.42,
      capabilities: ["typescript", "sqlite"],
      constraints: { max_latency_ms: 1200 },
      experiment_subject: "workspace-1",
    },
    candidateScores: [
      {
        lane_id: "codex",
        score: 0.92,
        reasons: ["healthy", "build lane"],
        components: { health: 1, cost: 0.8 },
      },
      {
        lane_id: "claude",
        score: 0.7,
        reasons: ["healthy"],
        components: { health: 1, cost: 0.4 },
      },
    ],
    result: "lane",
    chosenLane: "codex",
    policyVersion: "policy-v1",
    heuristic: "weighted-health-cost",
    experimentArm: "control",
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

test("recordDecision inserts routing_decisions metadata", () => {
  const ledger = new RouteLedger(":memory:");

  ledger.recordDecision(decision());

  const recorded = ledger.getDecision("decision-1");
  assert.ok(recorded);
  assert.equal(recorded.decisionId, "decision-1");
  assert.equal(recorded.policyVersion, "policy-v1");
  assert.equal(recorded.heuristic, "weighted-health-cost");
  assert.equal(recorded.experimentArm, "control");
  assert.equal(recorded.result, "lane");
  assert.equal(recorded.chosenLane, "codex");
  assert.equal(recorded.recordedAt, RECORDED_AT);
  assert.deepEqual(recorded.candidateScores, decision().candidateScores);
  assert.equal(recorded.outcome, null);
  ledger.close();
});

test("reportOutcome updates routing_outcomes without rewriting the original decision", () => {
  const store = new StateStore(":memory:");
  const ledger = new RouteLedger({ database: store.database });
  ledger.recordDecision(decision());

  const before = store.database
    .prepare(`SELECT request_summary, candidate_scores, chosen_lane FROM routing_decisions WHERE decision_id = ?`)
    .get("decision-1");

  const accepted = ledger.reportOutcome({
    decisionId: "decision-1",
    outcome: "completed",
    actualCost: 0.31,
    metadata: { latency_ms: 850, user_visible: true },
    reportedAt: REPORTED_AT,
  });

  const after = store.database
    .prepare(`SELECT request_summary, candidate_scores, chosen_lane FROM routing_decisions WHERE decision_id = ?`)
    .get("decision-1");
  const outcomeRows = store.database
    .prepare(`SELECT decision_id, outcome, actual_cost, metadata, reported_at FROM routing_outcomes`)
    .all()
    .map((row) => ({ ...row }));

  assert.equal(accepted, true);
  assert.deepEqual(after, before);
  assert.deepEqual(outcomeRows, [
    {
      decision_id: "decision-1",
      outcome: "completed",
      actual_cost: 0.31,
      metadata: JSON.stringify({ latency_ms: 850, user_visible: true }),
      reported_at: REPORTED_AT,
    },
  ]);
  store.close();
});

test("reportOutcome rejects unknown decisions", () => {
  const ledger = new RouteLedger(":memory:");

  assert.equal(
    ledger.reportOutcome({
      decisionId: "missing",
      outcome: "completed",
      actualCost: 0.1,
      reportedAt: REPORTED_AT,
    }),
    false,
  );
  assert.equal(ledger.getDecision("missing"), null);
  ledger.close();
});

test("recordDecision does not persist raw prompts, credentials, tokens, or arbitrary payloads", () => {
  const ledger = new RouteLedger(":memory:");

  ledger.recordDecision(
    decision({
      requestSummary: {
        taskType: "planning",
        estimatedCost: 1.2,
        capabilities: ["analysis"],
        constraints: {
          deadline: "soon",
          prompt: "launch-code",
          tokens: ["tok-secret"],
          nested: {
            credentials: { api_key: "key-secret" },
            keep: "safe-summary",
          },
        },
        experimentSubject: "workspace-2",
        prompt: "raw prompt secret",
        credentials: { password: "credential-secret" },
        tokens: ["top-level-token"],
        arbitrarySensitivePayload: { secret: "payload-secret" },
      } as RecordRouteDecisionInput["requestSummary"],
    }),
  );

  const recorded = ledger.getDecision("decision-1");
  assert.ok(recorded);
  const persisted = JSON.stringify(recorded.requestSummary);
  assert.match(persisted, /planning/);
  assert.match(persisted, /safe-summary/);
  assert.doesNotMatch(persisted, /raw prompt secret/);
  assert.doesNotMatch(persisted, /credential-secret/);
  assert.doesNotMatch(persisted, /top-level-token/);
  assert.doesNotMatch(persisted, /payload-secret/);
  assert.doesNotMatch(persisted, /launch-code/);
  assert.doesNotMatch(persisted, /tok-secret/);
  assert.doesNotMatch(persisted, /key-secret/);
  ledger.close();
});

test("getDecision returns original recommendation metadata with reported outcome metadata", () => {
  const ledger = new RouteLedger(":memory:");
  ledger.recordDecision(decision({ result: "no_route", chosenLane: null, experimentArm: null }));
  ledger.reportOutcome({
    decisionId: "decision-1",
    outcome: "deferred",
    actualCost: null,
    metadata: { reason: "no healthy lane" },
    reportedAt: REPORTED_AT,
  });

  const recorded = ledger.getDecision("decision-1");

  assert.deepEqual(recorded, {
    decisionId: "decision-1",
    requestSummary: {
      task_type: "build",
      estimated_cost: 0.42,
      capabilities: ["typescript", "sqlite"],
      constraints: { max_latency_ms: 1200 },
      experiment_subject: "workspace-1",
    },
    candidateScores: decision().candidateScores,
    result: "no_route",
    chosenLane: null,
    policyVersion: "policy-v1",
    heuristic: "weighted-health-cost",
    experimentArm: null,
    recordedAt: RECORDED_AT,
    outcome: {
      outcome: "deferred",
      actualCost: null,
      metadata: { reason: "no healthy lane" },
      reportedAt: REPORTED_AT,
    },
  });
  ledger.close();
});
