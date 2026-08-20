import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackoffPolicyRegistry } from "./registry.js";

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
