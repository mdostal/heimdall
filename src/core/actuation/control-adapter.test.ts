import { test } from "node:test";
import assert from "node:assert/strict";
import { StubControlAdapter } from "./control-adapter.js";
import type { Lane } from "../lane-registry.js";

const LANE: Lane = {
  lane_id: "claude@mathew.dostal",
  provider: "claude",
  credential_ref: "CLAUDE_TOKEN",
  credential: "fake",
};

test("fires exactly once per genuine transition (reuses hdl-04 ActuationStub semantics)", async () => {
  const logs: string[] = [];
  const adapter = new StubControlAdapter();
  // Inject a silent log by constructing directly isn't exposed here — verify
  // via getRecordedActions() instead, matching ActuationStub's own test style.
  await adapter.reconcile(LANE, "up");
  await adapter.reconcile(LANE, "degraded");

  const actions = adapter.getRecordedActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].from, "up");
  assert.equal(actions[0].to, "degraded");
});

test("does not fire again for repeated identical status", async () => {
  const adapter = new StubControlAdapter();
  await adapter.reconcile(LANE, "up");
  await adapter.reconcile(LANE, "degraded");
  await adapter.reconcile(LANE, "degraded");
  await adapter.reconcile(LANE, "degraded");

  assert.equal(adapter.getRecordedActions().length, 1);
});

test("does not fire on the very first observation (no prior status to compare)", async () => {
  const adapter = new StubControlAdapter();
  await adapter.reconcile(LANE, "up");
  assert.equal(adapter.getRecordedActions().length, 0);
});

test("logs loudly (console.warn) by default, not a quiet debug line", async () => {
  const originalWarn = console.warn;
  let warned = false;
  console.warn = (..._args: unknown[]) => {
    warned = true;
  };
  try {
    const adapter = new StubControlAdapter();
    await adapter.reconcile(LANE, "up");
    await adapter.reconcile(LANE, "down");
    assert.equal(warned, true, "StubControlAdapter must log via console.warn, not console.log");
  } finally {
    console.warn = originalWarn;
  }
});
