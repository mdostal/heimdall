import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyLoader, PolicyValidationError, resolveDefaultPolicyPath } from "./policy-loader.js";

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

test("hdl-desktop-app: resolveDefaultPolicyPath prefers HEIMDALL_REPO_ROOT over cwd", () => {
  const withOverride = resolveDefaultPolicyPath({ HEIMDALL_REPO_ROOT: "/bundled/heimdall" }, "/some/other/cwd");
  assert.equal(withOverride, join("/bundled/heimdall", "config", "routing-policy.yaml"));
});

test("hdl-desktop-app: resolveDefaultPolicyPath falls back to cwd when HEIMDALL_REPO_ROOT is unset and cwd is a real checkout", () => {
  const checkout = mkdtempSync(join(tmpdir(), "heimdall-checkout-"));
  mkdirSync(join(checkout, "config"), { recursive: true });
  writeFileSync(join(checkout, "config", "routing-policy.yaml"), VALID_POLICY, "utf8");

  const withoutOverride = resolveDefaultPolicyPath({}, checkout);
  assert.equal(withoutOverride, join(checkout, "config", "routing-policy.yaml"));
});

test("hdl-ao-01: resolveDefaultPolicyPath falls back to a fixed per-machine config dir when neither HEIMDALL_REPO_ROOT nor a real cwd checkout exist", () => {
  const cwdWithNoConfig = mkdtempSync(join(tmpdir(), "heimdall-no-checkout-"));
  const home = mkdtempSync(join(tmpdir(), "heimdall-home-"));

  const resolved = resolveDefaultPolicyPath({}, cwdWithNoConfig, home);
  assert.equal(resolved, join(home, ".config", "heimdall", "routing-policy.yaml"));
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
