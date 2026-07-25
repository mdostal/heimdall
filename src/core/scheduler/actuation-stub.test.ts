import { test } from "node:test";
import assert from "node:assert/strict";
import { ActuationStub } from "./actuation-stub.js";

const LANE = { lane_id: "claude@mathew.dostal", provider: "claude" };

test("does not fire on the first observation (no prior status to compare against)", () => {
  const stub = new ActuationStub(() => "2026-07-25T00:00:00.000Z", () => {});
  stub.onStatusChange(LANE, "up");
  assert.equal(stub.getRecordedActions().length, 0);
});

test("fires exactly once on a genuine status transition", () => {
  const stub = new ActuationStub(() => "2026-07-25T00:00:00.000Z", () => {});
  stub.onStatusChange(LANE, "up");
  stub.onStatusChange(LANE, "degraded");

  const actions = stub.getRecordedActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].from, "up");
  assert.equal(actions[0].to, "degraded");
});

test("does not fire again for repeated identical status", () => {
  const stub = new ActuationStub(() => "2026-07-25T00:00:00.000Z", () => {});
  stub.onStatusChange(LANE, "up");
  stub.onStatusChange(LANE, "degraded");
  stub.onStatusChange(LANE, "degraded");
  stub.onStatusChange(LANE, "degraded");

  assert.equal(stub.getRecordedActions().length, 1);
});

test("fires again on a second genuine transition", () => {
  const stub = new ActuationStub(() => "2026-07-25T00:00:00.000Z", () => {});
  stub.onStatusChange(LANE, "up");
  stub.onStatusChange(LANE, "degraded");
  stub.onStatusChange(LANE, "up");

  const actions = stub.getRecordedActions();
  assert.equal(actions.length, 2);
  assert.equal(actions[1].from, "degraded");
  assert.equal(actions[1].to, "up");
});

test("describes disabling the runtime on a healthy -> suspect transition", () => {
  const stub = new ActuationStub(() => "2026-07-25T00:00:00.000Z", () => {});
  stub.onStatusChange(LANE, "up");
  stub.onStatusChange(LANE, "down");
  assert.match(stub.getRecordedActions()[0].intendedAction, /disable/i);
});

test("describes re-enabling the runtime on a suspect -> healthy transition", () => {
  const stub = new ActuationStub(() => "2026-07-25T00:00:00.000Z", () => {});
  stub.onStatusChange(LANE, "down");
  stub.onStatusChange(LANE, "up");
  assert.match(stub.getRecordedActions()[0].intendedAction, /re-enable/i);
});

test("makes no real network/CLI call — pure in-memory bookkeeping only (structural check)", () => {
  const src = ActuationStub.toString();
  assert.ok(!/fetch\(|execFile|child_process|CommandRunner/.test(src), "actuation-stub.ts must stay a stub with no real external calls");
});

test("tracks lanes independently — one lane's transition does not affect another's baseline", () => {
  const stub = new ActuationStub(() => "2026-07-25T00:00:00.000Z", () => {});
  const laneA = { lane_id: "claude@mathew.dostal", provider: "claude" };
  const laneB = { lane_id: "codex", provider: "codex" };

  stub.onStatusChange(laneA, "up");
  stub.onStatusChange(laneB, "up");
  stub.onStatusChange(laneA, "down");

  const actions = stub.getRecordedActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].laneId, "claude@mathew.dostal");
});
