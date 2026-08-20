import { test } from "node:test";
import assert from "node:assert/strict";
import { StaticBackoff } from "./static-backoff.js";

test("hdl-bp-02: StaticBackoff returns baseIntervalMs unconditionally at consecutiveSuspectTicks = 1 (first suspect tick)", () => {
  const policy = new StaticBackoff();
  assert.equal(policy.nextDelayMs({ consecutiveSuspectTicks: 1, baseIntervalMs: 5000, config: {} }), 5000);
});

test("hdl-bp-02: StaticBackoff ignores consecutiveSuspectTicks entirely — same result at tick 1, 2, 50, and 1000", () => {
  const policy = new StaticBackoff();
  for (const consecutiveSuspectTicks of [1, 2, 50, 1000]) {
    assert.equal(
      policy.nextDelayMs({ consecutiveSuspectTicks, baseIntervalMs: 5000, config: {} }),
      5000,
      `tick ${consecutiveSuspectTicks} must still return the flat baseIntervalMs`,
    );
  }
});

test("hdl-bp-02: StaticBackoff ignores config entirely — a populated config object changes nothing", () => {
  const policy = new StaticBackoff();
  const withEmptyConfig = policy.nextDelayMs({ consecutiveSuspectTicks: 7, baseIntervalMs: 5000, config: {} });
  const withPopulatedConfig = policy.nextDelayMs({
    consecutiveSuspectTicks: 7,
    baseIntervalMs: 5000,
    config: { levelCap: 3, multiplier: 99, ceilingMs: 1 },
  });
  assert.equal(withEmptyConfig, 5000);
  assert.equal(withPopulatedConfig, 5000, "an unrelated/hostile config object must not perturb static's result");
});

test("hdl-bp-02: StaticBackoff scales with baseIntervalMs directly (it's the only input it honors)", () => {
  const policy = new StaticBackoff();
  assert.equal(policy.nextDelayMs({ consecutiveSuspectTicks: 1, baseIntervalMs: 300_000, config: {} }), 300_000);
});

test("hdl-bp-02: StaticBackoff reports name 'static' matching its registry key", () => {
  assert.equal(new StaticBackoff().name, "static");
});
