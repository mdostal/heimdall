import { test } from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "../state-store.js";
import { LocalTelemetryRecorder } from "./local-recorder.js";

test("hdl-ot-01: emitStatusFlip records a lane_status_flip telemetry event", () => {
  const store = new StateStore(":memory:");
  const recorder = new LocalTelemetryRecorder(store);
  recorder.emitStatusFlip({ laneId: "claude@x", provider: "claude", from: "up", to: "down" });

  const events = store.listRecentTelemetryEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "lane_status_flip");
  assert.deepEqual(events[0].labels, { laneId: "claude@x", provider: "claude", from: "up", to: "down" });
  store.close();
});

test("hdl-ot-01: emitActuationResult records an actuation_result telemetry event with success as a string label", () => {
  const store = new StateStore(":memory:");
  const recorder = new LocalTelemetryRecorder(store);
  recorder.emitActuationResult({
    laneId: "claude@x",
    provider: "claude",
    agentId: "agent-1",
    action: "disable",
    success: true,
  });

  const counts = store.getTelemetryEventCounts("actuation_result");
  assert.equal(counts.length, 1);
  assert.equal(counts[0].count, 1);
  assert.equal(counts[0].labels.success, "true");
  assert.equal(counts[0].labels.provider, "claude");
  store.close();
});

test("hdl-ot-01: emitTick is a deliberate no-op — no telemetry_events row", () => {
  const store = new StateStore(":memory:");
  const recorder = new LocalTelemetryRecorder(store);
  recorder.emitTick({ laneId: "claude@x", provider: "claude", source: "active_probe" });

  assert.equal(store.listRecentTelemetryEvents().length, 0);
  store.close();
});
