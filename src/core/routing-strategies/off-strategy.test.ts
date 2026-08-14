import { test } from "node:test";
import assert from "node:assert/strict";
import { OffStrategy } from "./off-strategy.js";
import { StateStore } from "../state-store.js";
import type { Lane } from "../lane-registry.js";
import type { TaskType } from "../route-selector.js";

function lane(lane_id: string, provider: string): Lane {
  return { lane_id, provider, model: provider, credential_ref: `${provider}_TOKEN`, credential: "secret" };
}

// hdl-rr-02: selectRoute now takes a RouteSelectionContext and returns
// {lane, detail?} — this helper keeps every assertion below byte-identical
// to pre-hdl-rr-02 (still comparing a bare lane_id or null).
function pick(strategy: OffStrategy, taskType: TaskType, candidates: readonly Lane[]): string | null {
  const store = new StateStore(":memory:");
  try {
    return strategy.selectRoute({ taskType, candidates, store }).lane?.lane_id ?? null;
  } finally {
    store.close();
  }
}

test("hdl-rs-02: OffStrategy always returns null, even with candidates available", () => {
  const strategy = new OffStrategy();
  const candidates = [lane("a", "claude"), lane("b", "codex")];
  assert.equal(pick(strategy, "build", candidates), null);
});

test("hdl-rs-02: OffStrategy returns null for zero candidates too", () => {
  const strategy = new OffStrategy();
  assert.equal(pick(strategy, "build", []), null);
});

test("hdl-rs-02: OffStrategy is stateless — repeated calls never start returning a pick", () => {
  const strategy = new OffStrategy();
  const candidates = [lane("a", "claude")];
  for (let i = 0; i < 5; i++) {
    assert.equal(pick(strategy, "build", candidates), null);
  }
});
