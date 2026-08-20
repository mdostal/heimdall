import { test } from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "../../state-store.js";
import {
  createBackoffPolicyRegistry,
  BACKOFF_POLICY_SETTING_KEY,
  DEFAULT_BACKOFF_POLICY_NAME,
  getActiveBackoffPolicyName,
  getBackoffPolicyNameForProvider,
  backoffPolicyOverrideSettingKey,
  getBackoffPolicyConfig,
  BACKOFF_PROGRESSIVE_LEVEL_CAP_SETTING_KEY,
  BACKOFF_EXPONENTIAL_MULTIPLIER_SETTING_KEY,
  BACKOFF_EXPONENTIAL_CEILING_MS_SETTING_KEY,
} from "./registry.js";

test("hdl-bp-02: createBackoffPolicyRegistry() returns exactly 3 named policies", () => {
  const registry = createBackoffPolicyRegistry();
  assert.deepEqual(Object.keys(registry).sort(), ["exponential", "progressive", "static"]);
});

test("hdl-bp-02: every registered policy's .name matches its registry key", () => {
  const registry = createBackoffPolicyRegistry();
  for (const [key, policy] of Object.entries(registry)) {
    assert.equal(policy.name, key, `policy registered under key '${key}' reports name '${policy.name}'`);
  }
});

test("hdl-bp-02: createBackoffPolicyRegistry() returns a fresh instance each call", () => {
  const a = createBackoffPolicyRegistry();
  const b = createBackoffPolicyRegistry();
  assert.notEqual(a.static, b.static);
  assert.notEqual(a.progressive, b.progressive);
  assert.notEqual(a.exponential, b.exponential);
});

test("hdl-bp-02: registry entries all implement nextDelayMs and agree with static's simplest case", () => {
  const registry = createBackoffPolicyRegistry();
  for (const policy of Object.values(registry)) {
    const delay = policy.nextDelayMs({
      consecutiveSuspectTicks: 1,
      baseIntervalMs: 5_000,
      config: { levelCap: 10, multiplier: 2, ceilingMs: 300_000 },
    });
    assert.equal(delay, 5_000, `${policy.name}'s first suspect tick (1-indexed) must equal baseIntervalMs`);
  }
});

// hdl-bp-04: getActiveBackoffPolicyName — mirrors route-selector.ts's
// getActiveRoutingStrategyName's exact default/valid/invalid-fallback shape.

test("hdl-bp-04: getActiveBackoffPolicyName defaults to 'static' when unset", () => {
  const store = new StateStore(":memory:");
  assert.equal(getActiveBackoffPolicyName(store), "static");
  assert.equal(DEFAULT_BACKOFF_POLICY_NAME, "static");
  store.close();
});

test("hdl-bp-04: getActiveBackoffPolicyName reflects a valid stored setting", () => {
  const store = new StateStore(":memory:");
  store.setSetting(BACKOFF_POLICY_SETTING_KEY, "progressive");
  assert.equal(getActiveBackoffPolicyName(store), "progressive");
  store.close();
});

test("hdl-bp-04: getActiveBackoffPolicyName falls back to the default for an unknown stored name", () => {
  const store = new StateStore(":memory:");
  store.setSetting(BACKOFF_POLICY_SETTING_KEY, "not-a-real-policy");
  assert.equal(getActiveBackoffPolicyName(store), "static");
  store.close();
});

// hdl-bp-04: per-provider override resolution — present + valid wins,
// absent/invalid falls through to the global choice, in both directions.

test("hdl-bp-04: getBackoffPolicyNameForProvider uses the provider-specific override when present and valid", () => {
  const store = new StateStore(":memory:");
  store.setSetting(BACKOFF_POLICY_SETTING_KEY, "static"); // global stays static
  store.setSetting(backoffPolicyOverrideSettingKey("ollama"), "exponential");
  assert.equal(getBackoffPolicyNameForProvider(store, "ollama"), "exponential", "present + valid override must win over the global choice");
  store.close();
});

test("hdl-bp-04: getBackoffPolicyNameForProvider falls through to the global choice when no override is set for that provider", () => {
  const store = new StateStore(":memory:");
  store.setSetting(BACKOFF_POLICY_SETTING_KEY, "progressive");
  assert.equal(getBackoffPolicyNameForProvider(store, "codex"), "progressive", "absent override must fall through to the global choice");
  store.close();
});

test("hdl-bp-04: getBackoffPolicyNameForProvider falls through to the global choice when the override is an unknown/invalid policy name", () => {
  const store = new StateStore(":memory:");
  store.setSetting(BACKOFF_POLICY_SETTING_KEY, "exponential");
  store.setSetting(backoffPolicyOverrideSettingKey("gemini"), "not-a-real-policy");
  assert.equal(getBackoffPolicyNameForProvider(store, "gemini"), "exponential", "invalid override must fall through, not throw or silently no-op");
  store.close();
});

test("hdl-bp-04: getBackoffPolicyNameForProvider is independent per provider — one provider's override does not leak to another's resolution", () => {
  const store = new StateStore(":memory:");
  store.setSetting(BACKOFF_POLICY_SETTING_KEY, "static");
  store.setSetting(backoffPolicyOverrideSettingKey("claude"), "progressive");
  assert.equal(getBackoffPolicyNameForProvider(store, "claude"), "progressive");
  assert.equal(getBackoffPolicyNameForProvider(store, "codex"), "static", "codex has no override of its own, must not inherit claude's");
  store.close();
});

// hdl-bp-04: per-policy parameter resolution — defaults and stored overrides.

test("hdl-bp-04: getBackoffPolicyConfig returns {} for static (and for an unrecognized policy name)", () => {
  const store = new StateStore(":memory:");
  assert.deepEqual(getBackoffPolicyConfig(store, "static"), {});
  assert.deepEqual(getBackoffPolicyConfig(store, "not-a-real-policy"), {});
  store.close();
});

test("hdl-bp-04: getBackoffPolicyConfig defaults progressive's levelCap to 10 when unset", () => {
  const store = new StateStore(":memory:");
  assert.deepEqual(getBackoffPolicyConfig(store, "progressive"), { levelCap: 10 });
  store.close();
});

test("hdl-bp-04: getBackoffPolicyConfig reflects a stored levelCap override", () => {
  const store = new StateStore(":memory:");
  store.setSetting(BACKOFF_PROGRESSIVE_LEVEL_CAP_SETTING_KEY, "4");
  assert.deepEqual(getBackoffPolicyConfig(store, "progressive"), { levelCap: 4 });
  store.close();
});

test("hdl-bp-04: getBackoffPolicyConfig defaults exponential's multiplier/ceilingMs to the design-discussion worked-example defaults (2 / 300000) when unset", () => {
  const store = new StateStore(":memory:");
  assert.deepEqual(getBackoffPolicyConfig(store, "exponential"), { multiplier: 2, ceilingMs: 300_000 });
  store.close();
});

test("hdl-bp-04: getBackoffPolicyConfig reflects stored multiplier/ceilingMs overrides", () => {
  const store = new StateStore(":memory:");
  store.setSetting(BACKOFF_EXPONENTIAL_MULTIPLIER_SETTING_KEY, "3");
  store.setSetting(BACKOFF_EXPONENTIAL_CEILING_MS_SETTING_KEY, "60000");
  assert.deepEqual(getBackoffPolicyConfig(store, "exponential"), { multiplier: 3, ceilingMs: 60_000 });
  store.close();
});
