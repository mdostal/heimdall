import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("recordStatus() never violates the lanes FK, even without a prior upsertLane() call", () => {
  const store = new StateStore(":memory:");

  assert.doesNotThrow(() =>
    store.recordStatus({
      lane_id: "never-upserted",
      status: "up",
      reset_at: null,
      reason: null,
      signal_source: "active_probe",
      observed_at: "2026-07-25T12:00:00.000Z",
    }),
  );

  const status = store.getCurrentStatus("never-upserted");
  assert.equal(status?.status, "up");
  store.close();
});

test("recordStatus()'s FK guard does not clobber a lane's real provider/credential_ref already on file", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at: "2026-07-25T12:00:00.000Z",
  });

  const lanes = store.listLanes().map((lane) => ({ ...lane }));
  assert.deepEqual(lanes, [
    { lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" },
  ]);
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

test("getManualOverride defaults to null for a lane with no override set (hdl-lo-01)", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  assert.equal(store.getManualOverride("claude@mathew.dostal"), null);
  store.close();
});

test("setManualOverride persists and getManualOverride reads it back (hdl-lo-01)", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  store.setManualOverride("claude@mathew.dostal", "disabled");
  assert.equal(store.getManualOverride("claude@mathew.dostal"), "disabled");

  store.setManualOverride("claude@mathew.dostal", "enabled");
  assert.equal(store.getManualOverride("claude@mathew.dostal"), "enabled");

  store.setManualOverride("claude@mathew.dostal", null);
  assert.equal(store.getManualOverride("claude@mathew.dostal"), null);
  store.close();
});

test("setManualOverride works even when the lane was never upserted first (guards row existence like recordStatus)", () => {
  const store = new StateStore(":memory:");

  assert.doesNotThrow(() => store.setManualOverride("never-upserted", "disabled"));
  assert.equal(store.getManualOverride("never-upserted"), "disabled");
  store.close();
});

test("setManualOverride does not clobber a lane's provider/credential_ref already on file", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  store.setManualOverride("claude@mathew.dostal", "enabled");

  const lanes = store.listLanes().map((lane) => ({ ...lane }));
  assert.deepEqual(lanes, [
    { lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" },
  ]);
  store.close();
});

test("upsertLane does not clobber a previously-set manual_override (re-upserts happen on every GET /lanes call)", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });
  store.setManualOverride("claude@mathew.dostal", "disabled");

  // Simulate a second GET /lanes call re-upserting the same lane.
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  assert.equal(store.getManualOverride("claude@mathew.dostal"), "disabled");
  store.close();
});

test("a StateStore opened against a DB file created before manual_override existed does not crash (defensive migration, hdl-lo-01)", () => {
  // Simulate a pre-hdl-lo-01 database by hand-rolling the OLD schema (no
  // manual_override column) directly, bypassing StateStore's constructor.
  const dbPath = path.join(os.tmpdir(), `heimdall-migration-test-${Date.now()}.sqlite`);
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE lanes (
      lane_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_ref TEXT NOT NULL
    );
  `);
  legacyDb.close();

  try {
    assert.doesNotThrow(() => {
      const store = new StateStore(dbPath);
      store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });
      store.setManualOverride("claude@mathew.dostal", "disabled");
      assert.equal(store.getManualOverride("claude@mathew.dostal"), "disabled");
      store.close();
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});
