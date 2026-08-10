import { test } from "node:test";
import assert from "node:assert/strict";
import { assignExperimentArm } from "./experiment-assigner.js";
import type { PolicyExperiments } from "./policy-loader.js";

const EVEN_SPLIT: PolicyExperiments = {
  enabled: true,
  arms: {
    baseline: { split: 0.5 },
    cost_aggressive: { split: 0.5 },
  },
};

test("assignExperimentArm returns the same arm for the same task_id across repeated calls", () => {
  const first = assignExperimentArm("task-123", EVEN_SPLIT);
  const second = assignExperimentArm("task-123", EVEN_SPLIT);
  assert.equal(first, second);
});

test("assignExperimentArm is deterministic across many distinct task_ids", () => {
  for (let i = 0; i < 200; i++) {
    const taskId = `task-${i}`;
    const first = assignExperimentArm(taskId, EVEN_SPLIT);
    const second = assignExperimentArm(taskId, EVEN_SPLIT);
    assert.equal(first, second, `mismatched assignment for ${taskId}`);
  }
});

test("assignExperimentArm distributes ~50/50 across 1000 unique task_ids within 10% tolerance", () => {
  const counts: Record<string, number> = { baseline: 0, cost_aggressive: 0 };
  for (let i = 0; i < 1000; i++) {
    const arm = assignExperimentArm(`task-${i}`, EVEN_SPLIT);
    counts[arm] = (counts[arm] ?? 0) + 1;
  }

  assert.equal(counts.baseline + counts.cost_aggressive, 1000);
  assert.ok(Math.abs(counts.baseline - 500) <= 100, `baseline count out of tolerance: ${counts.baseline}`);
  assert.ok(Math.abs(counts.cost_aggressive - 500) <= 100, `cost_aggressive count out of tolerance: ${counts.cost_aggressive}`);
});

test("assignExperimentArm always returns the sole arm for a single-arm experiment", () => {
  const singleArm: PolicyExperiments = {
    enabled: true,
    arms: { control: { split: 1 } },
  };

  for (let i = 0; i < 50; i++) {
    assert.equal(assignExperimentArm(`task-${i}`, singleArm), "control");
  }
});

test("assignExperimentArm honors unequal split ratios", () => {
  const skewed: PolicyExperiments = {
    enabled: true,
    arms: {
      control: { split: 0.9 },
      canary: { split: 0.1 },
    },
  };

  const counts: Record<string, number> = { control: 0, canary: 0 };
  for (let i = 0; i < 1000; i++) {
    const arm = assignExperimentArm(`task-${i}`, skewed);
    counts[arm] = (counts[arm] ?? 0) + 1;
  }

  assert.ok(counts.control > counts.canary);
  assert.ok(Math.abs(counts.control - 900) <= 100, `control count out of tolerance: ${counts.control}`);
});

test("assignExperimentArm throws for an experiment with no arms", () => {
  const empty: PolicyExperiments = { enabled: true, arms: {} };
  assert.throws(() => assignExperimentArm("task-1", empty));
});
