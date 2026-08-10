import { test } from "node:test";
import * as assert from "node:assert";
import { generateRationale } from "./rationale-generator.js";
import type { CandidateScore } from "./scorer.js";

test("generateRationale starts with the chosen lane and score", () => {
  const chosen: CandidateScore = {
    lane_id: "claude@mathew.dostal",
    score: 120,
    reasons: ["task_type_weight(claude)=100", "headroom_ok"],
  };
  const rejected: CandidateScore = {
    lane_id: "codex@work",
    score: 80,
    reasons: ["headroom_penalty(500 < 1000)"],
  };

  const rationale = generateRationale(chosen, [chosen, rejected]);
  assert.ok(rationale.startsWith("Chose claude@mathew.dostal (score 120)"));
});

test("generateRationale includes all reasons for the chosen lane", () => {
  const chosen: CandidateScore = {
    lane_id: "claude@mathew.dostal",
    score: 120,
    reasons: ["task_type_weight(claude)=100", "headroom_ok"],
  };

  const rationale = generateRationale(chosen, [chosen]);
  assert.ok(rationale.includes("task_type_weight(claude)=100"));
  assert.ok(rationale.includes("headroom_ok"));
});

test("generateRationale lists each rejected lane with its score and top rejection reason", () => {
  const chosen: CandidateScore = {
    lane_id: "claude@mathew.dostal",
    score: 120,
    reasons: ["task_type_weight(claude)=100"],
  };
  const rejectedA: CandidateScore = {
    lane_id: "codex@work",
    score: 80,
    reasons: ["headroom_penalty(500 < 1000)", "cost_tier_penalty(high)=-20"],
  };
  const rejectedB: CandidateScore = {
    lane_id: "gemini@personal",
    score: 60,
    reasons: ["task_type_weight(gemini)=60"],
  };

  const rationale = generateRationale(chosen, [chosen, rejectedA, rejectedB]);

  assert.ok(rationale.includes("codex@work (score 80, headroom_penalty(500 < 1000))"));
  assert.ok(rationale.includes("gemini@personal (score 60, task_type_weight(gemini)=60)"));
  assert.ok(!rationale.includes("cost_tier_penalty(high)=-20"));
});

test("generateRationale handles a rejected lane with no reasons", () => {
  const chosen: CandidateScore = {
    lane_id: "claude@mathew.dostal",
    score: 120,
    reasons: ["task_type_weight(claude)=100"],
  };
  const rejected: CandidateScore = {
    lane_id: "gemini@personal",
    score: 60,
    reasons: [],
  };

  const rationale = generateRationale(chosen, [chosen, rejected]);
  assert.ok(rationale.includes("gemini@personal (score 60)"));
  assert.ok(!rationale.includes("gemini@personal (score 60,"));
});

test("generateRationale handles no rejected candidates gracefully", () => {
  const chosen: CandidateScore = {
    lane_id: "claude@mathew.dostal",
    score: 120,
    reasons: ["task_type_weight(claude)=100"],
  };

  const rationale = generateRationale(chosen, [chosen]);
  assert.strictEqual(
    rationale,
    "Chose claude@mathew.dostal (score 120). Reasons: task_type_weight(claude)=100.",
  );
  assert.ok(!rationale.includes("Rejected:"));
});

test("generateRationale handles an empty candidates array gracefully", () => {
  const chosen: CandidateScore = {
    lane_id: "claude@mathew.dostal",
    score: 120,
    reasons: [],
  };

  const rationale = generateRationale(chosen, []);
  assert.strictEqual(rationale, "Chose claude@mathew.dostal (score 120). Reasons: (none).");
});
