import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedLevels, LevelConfigError, resolveLevel, validateLaneTiers, validateLevelPolicy } from "./levels.js";
import type { Lane } from "../lane-registry.js";

function lane(lane_id: string, model: string, models: Lane["models"] = []): Lane {
  return {
    lane_id,
    provider: "claude",
    credential_ref: "X",
    model,
    headroom: 10000,
    cost_tier: "medium",
    models,
    credential: "secret",
    credential_state: "resolved",
    credential_detail: null,
  };
}

const POLICY = validateLevelPolicy(
  { models: { "claude-opus-5-5": "premium", "claude-sonnet-5-5": "standard" }, lanes: { "legacy-lane": "premium" } },
  { planning: { levels: ["premium", "standard"] }, summaries: { levels: ["economy"] }, refactor: { levels: ["premium"], code_work: true } },
)!;

test("levels: neither section present means level routing is off", () => {
  assert.equal(validateLevelPolicy(undefined, undefined), null);
  assert.equal(validateLevelPolicy(null, null), null);
});

test("levels: work_classes without levels is rejected", () => {
  assert.throws(() => validateLevelPolicy(undefined, { build: { levels: ["premium"] } }), LevelConfigError);
});

test("levels: an unknown level, an empty level list or an unknown levels key is rejected", () => {
  assert.throws(() => validateLevelPolicy({ models: { m: "gold" } }, undefined), /levels\.models\.m/);
  assert.throws(() => validateLevelPolicy({ lanes: { l: 3 } }, undefined), /levels\.lanes\.l/);
  assert.throws(() => validateLevelPolicy({ providers: {} }, undefined), /levels\.providers/);
  assert.throws(() => validateLevelPolicy({}, { planning: { levels: [] } }), /work_classes\.planning\.levels/);
  assert.throws(() => validateLevelPolicy({}, { planning: { levels: ["premium", "cheap"] } }), /work_classes\.planning\.levels\.1/);
  assert.throws(() => validateLevelPolicy({}, { planning: { levels: ["premium"], code_work: "yes" } }), /code_work/);
});

test("levels: build, review, release and code can't be configured below premium", () => {
  for (const name of ["build", "review", "release", "code"]) {
    assert.throws(() => validateLevelPolicy({}, { [name]: { levels: ["premium", "standard"] } }), /may only run on premium/, name);
    assert.throws(() => validateLevelPolicy({}, { [name]: { levels: ["economy"] } }), /may only run on premium/, name);
    assert.doesNotThrow(() => validateLevelPolicy({}, { [name]: { levels: ["premium"] } }), name);
  }
});

test("levels: a class marked code_work is held to the floor too", () => {
  assert.throws(() => validateLevelPolicy({}, { migrations: { levels: ["standard"], code_work: true } }), /may only run on premium/);
});

test("levels: a class the policy doesn't list runs on premium only; lower levels are opt-in", () => {
  assert.deepEqual(allowedLevels(POLICY, "review").levels, ["premium"]);
  assert.deepEqual(allowedLevels(POLICY, "planning").levels, ["premium", "standard"]);
  assert.deepEqual(allowedLevels(POLICY, "planning", "summaries").levels, ["economy"]);
  assert.deepEqual(allowedLevels(POLICY, "planning", "never-configured").levels, ["premium"]);
});

test("levels: build and review keep the floor even when the caller names a looser work class", () => {
  const gate = allowedLevels(POLICY, "build", "planning");
  assert.deepEqual(gate.levels, ["premium"]);
  assert.equal(gate.floor, true);
  assert.equal(gate.work_class, "planning");
  assert.deepEqual(allowedLevels(POLICY, "review", "summaries").levels, ["premium"]);
  assert.equal(allowedLevels(POLICY, "planning", "refactor").floor, true);
  assert.equal(allowedLevels(POLICY, "planning", "release").floor, true);
  assert.equal(allowedLevels(POLICY, "planning").floor, false);
});

test("levels: resolution order is lane tier, then policy model, then policy lane; unbound is null", () => {
  assert.deepEqual(resolveLevel(POLICY, lane("a", "claude-opus-5-5"), "claude-opus-5-5"), { level: "premium", source: "policy_model" });
  assert.deepEqual(
    resolveLevel(POLICY, lane("a", "claude-opus-5-5", [{ id: "claude-opus-5-5", tier: "standard" }]), "claude-opus-5-5"),
    { level: "standard", source: "lane_config" },
  );
  assert.deepEqual(resolveLevel(POLICY, lane("legacy-lane", "claude"), "claude"), { level: "premium", source: "policy_lane" });
  assert.deepEqual(resolveLevel(POLICY, lane("legacy-lane", "claude-sonnet-5-5"), "claude-sonnet-5-5"), { level: "standard", source: "policy_model" });
  assert.deepEqual(resolveLevel(POLICY, lane("b", "gpt-codex"), "gpt-codex"), { level: null, source: null });
});

test("levels: a lane model tier that isn't a level is a config error", () => {
  assert.throws(() => validateLaneTiers([lane("a", "m", [{ id: "m", tier: "flagship" }])]), /Invalid tier "flagship" on model m of lane a/);
  assert.doesNotThrow(() => validateLaneTiers([lane("a", "m", [{ id: "m", tier: "economy" }, { id: "n" }])]));
});
