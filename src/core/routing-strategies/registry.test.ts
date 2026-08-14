import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoutingStrategyRegistry, DEFAULT_ROUTING_STRATEGY_NAME } from "./registry.js";

test("hdl-rr-03: the registry exposes exactly 4 named strategies", () => {
  const registry = createRoutingStrategyRegistry();
  assert.deepEqual(Object.keys(registry).sort(), ["off", "priority", "round-robin", "scored"]);
});

test("hdl-rs-02: every registered strategy's .name matches its registry key", () => {
  const registry = createRoutingStrategyRegistry();
  for (const [key, strategy] of Object.entries(registry)) {
    assert.equal(strategy.name, key, `strategy registered under key '${key}' reports name '${strategy.name}'`);
  }
});

test("hdl-rs-02: the default strategy name resolves to a registered strategy", () => {
  const registry = createRoutingStrategyRegistry();
  assert.equal(DEFAULT_ROUTING_STRATEGY_NAME, "priority");
  assert.ok(registry[DEFAULT_ROUTING_STRATEGY_NAME], "DEFAULT_ROUTING_STRATEGY_NAME must name a real registry entry");
});

test("hdl-rs-02: createRoutingStrategyRegistry() returns a fresh instance each call (no shared round-robin cursor leakage between callers)", () => {
  const a = createRoutingStrategyRegistry();
  const b = createRoutingStrategyRegistry();
  assert.notEqual(a["round-robin"], b["round-robin"]);
});
