import { test } from "node:test";
import assert from "node:assert/strict";
import { LaneRegistry } from "../core/lane-registry.js";
import { StateStore } from "../core/state-store.js";
import { EnvCredentialSource } from "../core/credential-source.js";
import { SensingMetrics } from "../core/telemetry/sensing-metrics.js";
import { evaluateReadiness, resolveReadinessStalenessMs, DEFAULT_READINESS_STALENESS_MS } from "./readiness.js";

function setup() {
  const registry = new LaneRegistry(
    [
      { lane_id: "claude@x", provider: "claude", credential_ref: "C" },
      { lane_id: "codex", provider: "codex", credential_ref: "C" },
    ],
    new EnvCredentialSource({ C: "secret" }),
  );
  const store = new StateStore(":memory:");
  for (const lane of registry.list()) {
    store.upsertLane({ lane_id: lane.lane_id, provider: lane.provider, credential_ref: lane.credential_ref });
  }
  return { registry, store };
}

const NOW = new Date("2026-09-27T12:00:00.000Z");

function observe(store: StateStore, laneId: string, secondsAgo: number) {
  store.recordStatus({
    lane_id: laneId,
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
  });
}

test("PANT-824: ready when schedulers started, DB writable and a lane was probed recently", () => {
  const { registry, store } = setup();
  observe(store, "codex", 30);
  const report = evaluateReadiness({ registry, store, sensing: new SensingMetrics(), now: () => NOW });
  assert.equal(report.status, "ready");
  assert.deepEqual(report.reasons, []);
  assert.equal(report.checks.probe_freshness.newest_probe_age_seconds, 30);
  store.close();
});

test("PANT-824: a scheduler start failure degrades readiness and names the lane", () => {
  const { registry, store } = setup();
  observe(store, "codex", 30);
  const sensing = new SensingMetrics();
  sensing.recordSchedulerStartFailure("claude@x", "in_process", new Error("timer exploded"));
  const report = evaluateReadiness({ registry, store, sensing, now: () => NOW });
  assert.equal(report.status, "degraded");
  assert.deepEqual(report.checks.schedulers.failed_lanes, ["claude@x"]);
  assert.match(report.reasons[0], /claude@x.*in_process.*timer exploded/);
  store.close();
});

test("PANT-824: degraded when no lane was probed within the staleness window, or never at all", () => {
  const { registry, store } = setup();
  const never = evaluateReadiness({ registry, store, now: () => NOW });
  assert.equal(never.status, "degraded");
  assert.deepEqual(never.reasons, ["no lane has ever been probed"]);

  observe(store, "claude@x", 3600);
  const stale = evaluateReadiness({ registry, store, stalenessMs: 15 * 60_000, now: () => NOW });
  assert.equal(stale.status, "degraded");
  assert.match(stale.reasons[0], /no lane probed in the last 900s \(newest observation 3600s ago\)/);

  // Only one lane needs to be fresh — per-lane staleness is the gauge's job.
  observe(store, "codex", 10);
  assert.equal(evaluateReadiness({ registry, store, now: () => NOW }).status, "ready");
  store.close();
});

test("PANT-824: an unwritable state DB degrades readiness", () => {
  const { registry, store } = setup();
  observe(store, "codex", 10);
  store.database.exec("PRAGMA query_only = ON");
  const report = evaluateReadiness({ registry, store, now: () => NOW });
  assert.equal(report.status, "degraded");
  assert.equal(report.checks.state_db.ok, false);
  assert.match(report.reasons[0], /state DB is not writable/);
  store.database.exec("PRAGMA query_only = OFF");
  // The write probe rolls back — nothing is left behind in settings.
  assert.equal(store.getSetting("__readiness_probe__"), null);
  store.close();
});

test("PANT-824: no declared lanes is ready (nothing to sense), and the staleness window is env-configurable", () => {
  const store = new StateStore(":memory:");
  const registry = new LaneRegistry([], new EnvCredentialSource({}));
  assert.equal(evaluateReadiness({ registry, store, now: () => NOW }).status, "ready");
  assert.equal(resolveReadinessStalenessMs({ HEIMDALL_READINESS_STALENESS_MS: "60000" }), 60_000);
  assert.equal(resolveReadinessStalenessMs({ HEIMDALL_READINESS_STALENESS_MS: "nope" }), DEFAULT_READINESS_STALENESS_MS);
  store.close();
});
