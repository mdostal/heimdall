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

test("hdl-error-taxonomy: error_code round-trips through recordStatus/getCurrentStatus", () => {
  const store = new StateStore(":memory:");
  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "degraded",
    reset_at: null,
    reason: "rate limited",
    error_code: "rate_limit",
    signal_source: "active_probe",
    observed_at: "2026-07-25T12:00:00.000Z",
  });

  assert.equal(store.getCurrentStatus("claude@mathew.dostal")?.error_code, "rate_limit");
  store.close();
});

test("hdl-error-taxonomy: error_code defaults to null when the caller omits it entirely (backward-compatible call sites)", () => {
  const store = new StateStore(":memory:");
  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at: "2026-07-25T12:00:00.000Z",
  });

  assert.equal(store.getCurrentStatus("claude@mathew.dostal")?.error_code, null);
  store.close();
});

test("hdl-error-taxonomy: a lane with no status recorded yet reports error_code: null (REQ-07 unconfigured fallback)", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });
  assert.equal(store.getCurrentStatus("claude@mathew.dostal")?.error_code, null);
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

test("getManualResetAt defaults to null for a lane with no manual reset_at set (hdl-lm-03)", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  assert.equal(store.getManualResetAt("claude@mathew.dostal"), null);
  store.close();
});

test("setManualResetAt persists and getManualResetAt reads it back, including clearing (hdl-lm-03)", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });

  store.setManualResetAt("claude@mathew.dostal", "2026-08-13T18:00:00.000Z");
  assert.equal(store.getManualResetAt("claude@mathew.dostal"), "2026-08-13T18:00:00.000Z");

  store.setManualResetAt("claude@mathew.dostal", null);
  assert.equal(store.getManualResetAt("claude@mathew.dostal"), null);
  store.close();
});

test("setManualResetAt works even when the lane was never upserted first (hdl-lm-03)", () => {
  const store = new StateStore(":memory:");

  assert.doesNotThrow(() => store.setManualResetAt("never-upserted", "2026-08-13T18:00:00.000Z"));
  assert.equal(store.getManualResetAt("never-upserted"), "2026-08-13T18:00:00.000Z");
  store.close();
});

test("setManualResetAt does not clobber manual_override or provider/credential_ref already on file (hdl-lm-03)", () => {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });
  store.setManualOverride("claude@mathew.dostal", "disabled");

  store.setManualResetAt("claude@mathew.dostal", "2026-08-13T18:00:00.000Z");

  assert.equal(store.getManualOverride("claude@mathew.dostal"), "disabled");
  const lanes = store.listLanes().map((lane) => ({ ...lane }));
  assert.deepEqual(lanes, [
    { lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" },
  ]);
  store.close();
});

test("a StateStore opened against a DB file created before manual_reset_at existed does not crash (defensive migration, hdl-lm-03)", () => {
  // Simulate a pre-hdl-lm-03 database — has manual_override (hdl-lo-01) but
  // not yet manual_reset_at.
  const dbPath = path.join(os.tmpdir(), `heimdall-migration-test-lm03-${Date.now()}.sqlite`);
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE lanes (
      lane_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      manual_override TEXT
    );
  `);
  legacyDb.close();

  try {
    assert.doesNotThrow(() => {
      const store = new StateStore(dbPath);
      store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });
      store.setManualResetAt("claude@mathew.dostal", "2026-08-13T18:00:00.000Z");
      assert.equal(store.getManualResetAt("claude@mathew.dostal"), "2026-08-13T18:00:00.000Z");
      store.close();
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test("hdl-error-taxonomy: a StateStore opened against a DB file created before error_code existed does not crash (defensive migration)", () => {
  // Simulate a pre-hdl-error-taxonomy database — lane_status_history exists
  // but has no error_code column yet.
  const dbPath = path.join(os.tmpdir(), `heimdall-migration-test-error-code-${Date.now()}.sqlite`);
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE lanes (
      lane_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_ref TEXT NOT NULL
    );
    CREATE TABLE lane_status_history (
      lane_id TEXT NOT NULL REFERENCES lanes(lane_id),
      status TEXT NOT NULL,
      reset_at TEXT,
      reason TEXT,
      signal_source TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
  `);
  legacyDb.close();

  try {
    assert.doesNotThrow(() => {
      const store = new StateStore(dbPath);
      store.recordStatus({
        lane_id: "claude@mathew.dostal",
        status: "degraded",
        reset_at: null,
        reason: "rate limited",
        error_code: "rate_limit",
        signal_source: "active_probe",
        observed_at: "2026-08-16T00:00:00.000Z",
      });
      assert.equal(store.getCurrentStatus("claude@mathew.dostal")?.error_code, "rate_limit");
      store.close();
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test("hdl-rs-03: getSetting returns null for a key that was never set", () => {
  const store = new StateStore(":memory:");
  assert.equal(store.getSetting("routing_strategy"), null);
  store.close();
});

test("hdl-rs-03: setSetting persists and getSetting reads it back, including overwriting an existing value", () => {
  const store = new StateStore(":memory:");
  store.setSetting("routing_strategy", "round-robin");
  assert.equal(store.getSetting("routing_strategy"), "round-robin");

  store.setSetting("routing_strategy", "off");
  assert.equal(store.getSetting("routing_strategy"), "off");
  store.close();
});

test("hdl-rs-03: settings is a generic table — independent keys don't collide", () => {
  const store = new StateStore(":memory:");
  store.setSetting("routing_strategy", "priority");
  store.setSetting("some_other_future_setting", "value-x");

  assert.equal(store.getSetting("routing_strategy"), "priority");
  assert.equal(store.getSetting("some_other_future_setting"), "value-x");
  store.close();
});

test("hdl-mc-01: upsertModelSeen on a new (provider, model_id) pair sets enabled to the given default", () => {
  const store = new StateStore(":memory:");
  store.upsertModelSeen({
    provider: "claude",
    model_id: "claude-opus-5",
    default_enabled: true,
    provider_created_at: "2026-02-04T00:00:00.000Z",
    seen_at: "2026-08-13T00:00:00.000Z",
  });
  const [entry] = store.getModelCatalog("claude");
  assert.equal(entry.enabled, true);
  assert.equal(entry.provider_created_at, "2026-02-04T00:00:00.000Z");
  assert.equal(entry.first_seen_at, "2026-08-13T00:00:00.000Z");
  assert.equal(entry.last_seen_at, "2026-08-13T00:00:00.000Z");
  store.close();
});

test("hdl-mc-01: upsertModelSeen on an ALREADY-KNOWN pair never touches enabled, only advances last_seen_at", () => {
  const store = new StateStore(":memory:");
  store.upsertModelSeen({
    provider: "gemini",
    model_id: "gemini-2.5-pro",
    default_enabled: false,
    provider_created_at: null,
    seen_at: "2026-08-01T00:00:00.000Z",
  });

  // A second sighting passes default_enabled: true — must NOT flip the stored value.
  store.upsertModelSeen({
    provider: "gemini",
    model_id: "gemini-2.5-pro",
    default_enabled: true,
    provider_created_at: null,
    seen_at: "2026-08-13T00:00:00.000Z",
  });

  const [entry] = store.getModelCatalog("gemini");
  assert.equal(entry.enabled, false, "enabled must be preserved from first sight, not reset by the second call's default");
  assert.equal(entry.first_seen_at, "2026-08-01T00:00:00.000Z", "first_seen_at never changes after the first sighting");
  assert.equal(entry.last_seen_at, "2026-08-13T00:00:00.000Z", "last_seen_at advances on every sighting");
  store.close();
});

test("hdl-mc-01: setModelEnabled overrides enabled and survives a subsequent upsertModelSeen call", () => {
  const store = new StateStore(":memory:");
  store.upsertModelSeen({
    provider: "codex",
    model_id: "gpt-codex",
    default_enabled: true,
    provider_created_at: null,
    seen_at: "2026-08-01T00:00:00.000Z",
  });

  const updated = store.setModelEnabled("codex", "gpt-codex", false);
  assert.equal(updated, true);
  assert.equal(store.getModelCatalog("codex")[0].enabled, false);

  // A later refresh sighting must not undo the operator's explicit choice.
  store.upsertModelSeen({
    provider: "codex",
    model_id: "gpt-codex",
    default_enabled: true,
    provider_created_at: null,
    seen_at: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(store.getModelCatalog("codex")[0].enabled, false, "operator override survives refresh");
  store.close();
});

test("hdl-mc-01: setModelEnabled returns false for an unknown (provider, model_id) pair — no row to update", () => {
  const store = new StateStore(":memory:");
  const updated = store.setModelEnabled("claude", "never-seen-model", true);
  assert.equal(updated, false);
  store.close();
});

test("hdl-mc-01: getModelCatalog with a provider filter returns only that provider's entries", () => {
  const store = new StateStore(":memory:");
  store.upsertModelSeen({ provider: "claude", model_id: "claude-opus-5", default_enabled: true, provider_created_at: null, seen_at: "2026-08-13T00:00:00.000Z" });
  store.upsertModelSeen({ provider: "gemini", model_id: "gemini-3-pro-preview", default_enabled: true, provider_created_at: null, seen_at: "2026-08-13T00:00:00.000Z" });

  const claudeOnly = store.getModelCatalog("claude");
  assert.equal(claudeOnly.length, 1);
  assert.equal(claudeOnly[0].provider, "claude");

  const all = store.getModelCatalog();
  assert.equal(all.length, 2);
  store.close();
});

test("hdl-mc-01: a StateStore opened against a DB file created before model_catalog existed does not crash (defensive migration)", () => {
  // model_catalog is a new TABLE (not a new column on an existing table),
  // so CREATE TABLE IF NOT EXISTS in SCHEMA already covers a pre-existing
  // DB file with no defensive ALTER TABLE needed — this test documents
  // that the constructor still succeeds against a DB file that predates
  // this table's existence (a real .env-adjacent DB from before this
  // epic), not just a fresh :memory: store.
  const dbPath = path.join(os.tmpdir(), `hdl-mc-01-pre-existing-${Date.now()}.db`);
  try {
    const legacyStore = new StateStore(dbPath);
    legacyStore.upsertLane({ lane_id: "claude@test", provider: "claude", credential_ref: "T" });
    legacyStore.close();

    const store = new StateStore(dbPath);
    store.upsertModelSeen({ provider: "claude", model_id: "claude-opus-5", default_enabled: true, provider_created_at: null, seen_at: "2026-08-13T00:00:00.000Z" });
    assert.equal(store.getModelCatalog("claude").length, 1);
    store.close();
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test("hdl-ot-01: recordTelemetryEvent + listRecentTelemetryEvents round-trip labels as an object, newest first", () => {
  const store = new StateStore(":memory:");
  store.recordTelemetryEvent("rotation_event", { provider: "claude", kind: "capped" }, "2026-08-14T00:00:00.000Z");
  store.recordTelemetryEvent("rotation_event", { provider: "claude", kind: "rotated" }, "2026-08-14T00:00:01.000Z");

  const events = store.listRecentTelemetryEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].labels.kind, "rotated", "newest first");
  assert.equal(events[1].labels.kind, "capped");
  store.close();
});

test("hdl-ot-01: getTelemetryEventCounts groups by distinct label combination within one event type", () => {
  const store = new StateStore(":memory:");
  store.recordTelemetryEvent("actuation_result", { provider: "claude", success: "true" });
  store.recordTelemetryEvent("actuation_result", { provider: "claude", success: "true" });
  store.recordTelemetryEvent("actuation_result", { provider: "claude", success: "false" });
  store.recordTelemetryEvent("model_substitution", { provider: "gemini" }); // different event_type, must not leak in

  const counts = store.getTelemetryEventCounts("actuation_result");
  assert.equal(counts.length, 2);
  const bySuccess = Object.fromEntries(counts.map((c) => [c.labels.success, c.count]));
  assert.equal(bySuccess.true, 2);
  assert.equal(bySuccess.false, 1);
  store.close();
});

test("hdl-ot-01: getTelemetryEventCounts for an event type with zero events returns an empty array, never a crash", () => {
  const store = new StateStore(":memory:");
  assert.deepEqual(store.getTelemetryEventCounts("rotation_event"), []);
  store.close();
});
