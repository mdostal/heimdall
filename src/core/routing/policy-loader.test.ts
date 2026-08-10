import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyLoader, PolicyValidationError } from "./policy-loader.js";

const VALID_POLICY = `version: "1.0"
task_type_weights:
  planning:
    claude: 100
    gemini: 80
    codex: 60
    kimi: 40
  build:
    codex: 100
    claude: 80
    gemini: 60
    kimi: 40
  review:
    claude: 100
    codex: 80
    gemini: 60
    kimi: 40
headroom_floor: 1000
cost_preference: balanced
experiments:
  enabled: true
  arms:
    control:
      split: 0.75
    economy_bias:
      split: 0.25
`;

function writePolicy(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "heimdall-policy-")), "routing-policy.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

test("load reads the checked-in routing policy by default", () => {
  const policy = PolicyLoader.load();

  assert.equal(policy.task_type_weights.planning.claude, 100);
  assert.equal(policy.task_type_weights.build.codex, 100);
  assert.equal(policy.task_type_weights.review.claude, 100);
  assert.equal(policy.headroom_floor, 1000);
  assert.equal(policy.cost_preference, "balanced");
  assert.deepEqual(policy.experiments.arms.control, { split: 1 });
});

test("load returns a typed policy from valid YAML", () => {
  const policy = PolicyLoader.load(writePolicy(VALID_POLICY));

  assert.equal(policy.version, "1.0");
  assert.deepEqual(policy.task_type_weights.planning, {
    claude: 100,
    gemini: 80,
    codex: 60,
    kimi: 40,
  });
  assert.deepEqual(policy.task_type_weights.build, {
    codex: 100,
    claude: 80,
    gemini: 60,
    kimi: 40,
  });
  assert.equal(policy.headroom_floor, 1000);
  assert.equal(policy.cost_preference, "balanced");
});

test("load throws a descriptive validation error for a missing required field", () => {
  const path = writePolicy(VALID_POLICY.replace("headroom_floor: 1000\n", ""));

  assert.throws(
    () => PolicyLoader.load(path),
    (error: unknown) =>
      error instanceof PolicyValidationError &&
      /Missing required field "headroom_floor"/.test(error.message),
  );
});

test("load throws a descriptive validation error for malformed YAML", () => {
  const path = writePolicy(`version: "1.0"\ntask_type_weights:\n  planning: [`);

  assert.throws(
    () => PolicyLoader.load(path),
    (error: unknown) =>
      error instanceof PolicyValidationError && /Invalid YAML/.test(error.message),
  );
});

test("load parses experiment arm names and split ratios", () => {
  const policy = PolicyLoader.load(writePolicy(VALID_POLICY));

  assert.deepEqual(policy.experiments, {
    enabled: true,
    arms: {
      control: { split: 0.75 },
      economy_bias: { split: 0.25 },
    },
  });
});
