import { test } from "node:test";
import * as assert from "node:assert";
import {
  scoreCandidate,
  rankCandidates,
  type Policy,
  type LaneHealth,
  type RouteRequest,
} from "./scorer.js";

test("scoreCandidate applies task-type weights", () => {
  const lane: LaneHealth = {
    lane_id: "claude-1",
    provider: "claude",
    headroom: 2000,
  };
  const request: RouteRequest = { task_type: "planning" };
  const policy: Policy = {
    task_type_weights: {
      planning: { claude: 100 },
    },
    headroom_floor: 1000,
  };

  const result = scoreCandidate(lane, request, policy);
  assert.strictEqual(result.score, 100);
  assert.ok(result.reasons.includes("task_type_weight(claude)=100"));
});

test("scoreCandidate applies headroom penalty", () => {
  const lane: LaneHealth = {
    lane_id: "claude-1",
    provider: "claude",
    headroom: 500,
  };
  const request: RouteRequest = { task_type: "planning" };
  const policy: Policy = {
    task_type_weights: {
      planning: { claude: 0 },
    },
    headroom_floor: 1000,
  };

  const result = scoreCandidate(lane, request, policy);
  assert.strictEqual(result.score, -50);
  assert.ok(result.reasons.includes("headroom_penalty(500 < 1000)"));
});

test("scoreCandidate applies cost tier adjustment", () => {
  const lane: LaneHealth = {
    lane_id: "claude-1",
    provider: "claude",
    headroom: 2000,
    cost_tier: "high",
  };
  const request: RouteRequest = { task_type: "planning" };
  const policy: Policy = {
    task_type_weights: {
      planning: { claude: 100 },
    },
    headroom_floor: 1000,
    cost_preference: "cost",
  };

  const result = scoreCandidate(lane, request, policy);
  assert.strictEqual(result.score, 80); // 100 - 20
  assert.ok(result.reasons.includes("cost_tier_penalty(high)=-20"));
});

test("rankCandidates sorts by score descending and breaks ties lexicographically by lane_id", () => {
  const scores = [
    { lane_id: "lane-b", score: 100, reasons: [] },
    { lane_id: "lane-c", score: 100, reasons: [] },
    { lane_id: "lane-a", score: 100, reasons: [] },
    { lane_id: "lane-d", score: 150, reasons: [] },
    { lane_id: "lane-e", score: 50, reasons: [] },
  ];

  const ranked = rankCandidates(scores);

  assert.deepStrictEqual(
    ranked.map((r) => r.lane_id),
    [
      "lane-d", // 150
      "lane-a", // 100, a
      "lane-b", // 100, b
      "lane-c", // 100, c
      "lane-e", // 50
    ],
  );
});
