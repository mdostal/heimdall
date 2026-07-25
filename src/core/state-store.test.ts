import { test } from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "./state-store.js";

test("a declared lane with no recorded status reports down/unconfigured (REQ-07)", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  const status = store.getCurrentStatus("claude@mathew.dostal");
  assert.ok(status);
  assert.equal(status?.status, "down");
  assert.match(status?.reason ?? "", /unconfigured/);
  store.close();
});

test("an undeclared lane returns null, not a fabricated status", () => {
  const store = new StateStore(":memory:");
  assert.equal(store.getCurrentStatus("never-declared"), null);
  store.close();
});

test("current status = latest row per lane_id", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "passive",
    observed_at: "2026-07-25T00:00:00.000Z",
  });
  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "degraded",
    reset_at: null,
    reason: "elevated latency",
    signal_source: "public_status",
    observed_at: "2026-07-25T00:05:00.000Z",
  });

  const status = store.getCurrentStatus("claude@mathew.dostal");
  assert.equal(status?.status, "degraded");
  assert.equal(status?.reason, "elevated latency");
  assert.equal(status?.last_updated, "2026-07-25T00:05:00.000Z");
  store.close();
});

test("current status breaks observed_at ties by insertion order (rowid)", () => {
  // Two rapid successive writes can share the same millisecond timestamp —
  // "latest row" must still mean "most recently inserted", not an arbitrary
  // tie-break. Regression test for a real bug found via lane-pipeline.test.ts's
  // consecutive-probe corroboration scenario.
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  const sameTimestamp = "2026-07-25T12:00:00.000Z";
  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "degraded",
    reset_at: null,
    reason: "first",
    signal_source: "active_probe",
    observed_at: sameTimestamp,
  });
  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "down",
    reset_at: null,
    reason: "second",
    signal_source: "active_probe",
    observed_at: sameTimestamp,
  });

  const status = store.getCurrentStatus("claude@mathew.dostal");
  assert.equal(status?.reason, "second");
  assert.equal(status?.status, "down");
  store.close();
});

test("getLastObservedAt breaks observed_at ties by insertion order (rowid)", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  const sameTimestamp = "2026-07-25T12:00:00.000Z";
  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "passive",
    observed_at: sameTimestamp,
  });
  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "passive",
    observed_at: sameTimestamp,
  });

  assert.equal(store.getLastObservedAt("claude@mathew.dostal", "passive"), sameTimestamp);
  store.close();
});

test("upsertLane updates provider/credential_ref without duplicating the row", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "OLD_REF" });
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "NEW_REF" });

  const lanes = store.listLanes();
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].credential_ref, "NEW_REF");
  store.close();
});

test("getAllCurrentStatuses returns one entry per declared lane", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" });

  const statuses = store.getAllCurrentStatuses();
  assert.equal(statuses.length, 2);
  store.close();
});
