import { test } from "node:test";
import assert from "node:assert/strict";
import { OffStrategy } from "./off-strategy.js";
import type { Lane } from "../lane-registry.js";

function lane(lane_id: string, provider: string): Lane {
  return { lane_id, provider, model: provider, credential_ref: `${provider}_TOKEN`, credential: "secret" };
}

test("hdl-rs-02: OffStrategy always returns null, even with candidates available", () => {
  const strategy = new OffStrategy();
  const candidates = [lane("a", "claude"), lane("b", "codex")];
  assert.equal(strategy.selectRoute("build", candidates), null);
});

test("hdl-rs-02: OffStrategy returns null for zero candidates too", () => {
  const strategy = new OffStrategy();
  assert.equal(strategy.selectRoute("build", []), null);
});

test("hdl-rs-02: OffStrategy is stateless — repeated calls never start returning a pick", () => {
  const strategy = new OffStrategy();
  const candidates = [lane("a", "claude")];
  for (let i = 0; i < 5; i++) {
    assert.equal(strategy.selectRoute("build", candidates), null);
  }
});
