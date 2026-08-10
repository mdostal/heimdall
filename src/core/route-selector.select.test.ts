import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteSelector, type RouteRequest } from "./route-selector.js";
import { RouteLedger } from "./routing/route-ledger.js";
import type { Policy } from "./routing/policy-loader.js";
import type { LaneHealth } from "./routing/scorer.js";

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: "1.0",
    task_type_weights: {
      planning: { claude: 100, codex: 60 },
      build: { codex: 100, claude: 80 },
      review: { claude: 100, codex: 80 },
    },
    headroom_floor: 1000,
    cost_preference: "balanced",
    experiments: { enabled: false, arms: { control: { split: 1 } } },
    ...overrides,
  };
}

test("select() returns a RouteResult and records a matching ledger entry for the chosen lane", () => {
  const ledger = new RouteLedger(":memory:");
  const selector = new RouteSelector(policy(), ledger, {
    now: () => new Date("2026-08-09T00:00:00.000Z"),
    generateDecisionId: () => "decision-fixed-1",
  });

  const request: RouteRequest = { task_id: "task-1", task_type: "build" };
  const laneHealth: LaneHealth[] = [
    { lane_id: "codex-1", provider: "codex", headroom: 2000 },
    { lane_id: "claude-1", provider: "claude", headroom: 2000 },
  ];

  const result = selector.select(request, laneHealth);

  assert.equal(result.decision_id, "decision-fixed-1");
  assert.equal(result.chosen_lane, "codex-1");
  assert.equal(result.policy_version, "1.0");
  assert.equal(result.experiment_arm, null);
  assert.deepEqual(
    result.ranked_candidates.map((c) => c.lane_id),
    ["codex-1", "claude-1"],
  );
  assert.match(result.rationale, /Chose codex-1/);

  const recorded = ledger.getDecision("decision-fixed-1");
  assert.ok(recorded);
  assert.equal(recorded.result, "lane");
  assert.equal(recorded.chosenLane, "codex-1");
  assert.equal(recorded.policyVersion, "1.0");
  assert.deepEqual(recorded.candidateScores, result.ranked_candidates);
  ledger.close();
});

test("select() assigns a deterministic experiment arm by task_id when experiments are enabled", () => {
  const ledger = new RouteLedger(":memory:");
  const selector = new RouteSelector(
    policy({ experiments: { enabled: true, arms: { baseline: { split: 0.5 }, canary: { split: 0.5 } } } }),
    ledger,
  );
  const laneHealth: LaneHealth[] = [{ lane_id: "codex-1", provider: "codex", headroom: 2000 }];

  const first = selector.select({ task_id: "task-42", task_type: "build" }, laneHealth);
  const second = selector.select({ task_id: "task-42", task_type: "build" }, laneHealth);

  assert.ok(first.experiment_arm === "baseline" || first.experiment_arm === "canary");
  assert.equal(first.experiment_arm, second.experiment_arm);
  ledger.close();
});

test("select() returns chosen_lane=null and logs result='no_route' when every lane is below the headroom floor", () => {
  const ledger = new RouteLedger(":memory:");
  const selector = new RouteSelector(policy({ headroom_floor: 1000 }), ledger, {
    generateDecisionId: () => "decision-no-route",
  });

  const result = selector.select({ task_id: "task-2", task_type: "build" }, [
    { lane_id: "codex-1", provider: "codex", headroom: 100 },
    { lane_id: "claude-1", provider: "claude", headroom: 50 },
  ]);

  assert.equal(result.chosen_lane, null);
  assert.match(result.rationale, /No candidate lane/);

  const recorded = ledger.getDecision("decision-no-route");
  assert.ok(recorded);
  assert.equal(recorded.result, "no_route");
  assert.equal(recorded.chosenLane, null);
  assert.equal(recorded.candidateScores.length, 2);
  ledger.close();
});

test("select() returns chosen_lane=null and logs result='no_route' when no lanes are supplied at all", () => {
  const ledger = new RouteLedger(":memory:");
  const selector = new RouteSelector(policy(), ledger, { generateDecisionId: () => "decision-empty" });

  const result = selector.select({ task_id: "task-3", task_type: "planning" }, []);

  assert.equal(result.chosen_lane, null);
  assert.deepEqual(result.ranked_candidates, []);

  const recorded = ledger.getDecision("decision-empty");
  assert.ok(recorded);
  assert.equal(recorded.result, "no_route");
  ledger.close();
});

test("select() still returns a result when the ledger write fails, without throwing", () => {
  const ledger = new RouteLedger(":memory:");
  ledger.close(); // force subsequent recordDecision() calls to throw

  const selector = new RouteSelector(policy(), ledger);
  const result = selector.select({ task_id: "task-4", task_type: "build" }, [
    { lane_id: "codex-1", provider: "codex", headroom: 2000 },
  ]);

  assert.equal(result.chosen_lane, "codex-1");
});
