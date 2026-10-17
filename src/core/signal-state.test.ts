import { test } from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "./state-store.js";
import type { LaneStatusValue } from "./status-model.js";
import { HEALTHY_PROBE_INTERVAL_MS } from "./scheduler/in-process-scheduler.js";
import {
  BACKOFF_EXPONENTIAL_CEILING_MS_SETTING_KEY,
  BACKOFF_POLICY_SETTING_KEY,
} from "./scheduler/backoff-policies/registry.js";
import {
  computeSignalState,
  DEFAULT_SIGNAL_STALE_MULTIPLIER,
  expectedProbeIntervalMs,
  getLaneSignal,
  resolveSignalStaleMultiplier,
  type SignalState,
} from "./signal-state.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

// Default threshold: 3 × 5 min = 15 min.
const cases: Array<{ name: string; status: LaneStatusValue; observedMinutesAgo: number | null; expected: SignalState }> = [
  { name: "never probed", status: "down", observedMinutesAgo: null, expected: "never_probed" },
  { name: "probed just now (up)", status: "up", observedMinutesAgo: 0, expected: "fresh" },
  { name: "probed just now (down)", status: "down", observedMinutesAgo: 0, expected: "fresh" },
  { name: "probed inside the threshold", status: "up", observedMinutesAgo: 14, expected: "fresh" },
  { name: "last probe older than the threshold (up)", status: "up", observedMinutesAgo: 16, expected: "stale" },
  { name: "last probe older than the threshold (down)", status: "down", observedMinutesAgo: 180, expected: "stale" },
];

for (const c of cases) {
  test(`PANT-823: getLaneSignal — ${c.name} → ${c.expected}, status unchanged`, () => {
    const store = new StateStore(":memory:");
    store.upsertLane({ lane_id: "claude@x", provider: "claude", credential_ref: "C" });
    if (c.observedMinutesAgo !== null) {
      store.recordStatus({
        lane_id: "claude@x",
        status: c.status,
        reset_at: null,
        reason: null,
        signal_source: "active_probe",
        observed_at: minutesAgo(c.observedMinutesAgo),
      });
    }
    const before = store.getCurrentStatus("claude@x");

    const signal = getLaneSignal(store, "claude@x", { now: NOW, multiplier: 3 });

    assert.equal(signal.signal_state, c.expected);
    assert.equal(signal.last_probed_at, c.observedMinutesAgo === null ? null : minutesAgo(c.observedMinutesAgo));
    // REQ-07: signal_state is additive — the lane's status is never rewritten.
    assert.deepEqual(store.getCurrentStatus("claude@x"), before);
    assert.equal(before?.status, c.status);
    store.close();
  });
}

test("PANT-823: the stale multiplier is configurable", () => {
  const input = { lastProbedAt: minutesAgo(12), status: "up" as const, resetAt: null, expectedIntervalMs: HEALTHY_PROBE_INTERVAL_MS, now: NOW };
  assert.equal(computeSignalState({ ...input, multiplier: 3 }), "fresh");
  assert.equal(computeSignalState({ ...input, multiplier: 2 }), "stale");

  assert.equal(resolveSignalStaleMultiplier({}), DEFAULT_SIGNAL_STALE_MULTIPLIER);
  assert.equal(resolveSignalStaleMultiplier({ HEIMDALL_SIGNAL_STALE_MULTIPLIER: "5" }), 5);
  assert.equal(resolveSignalStaleMultiplier({ HEIMDALL_SIGNAL_STALE_MULTIPLIER: "0" }), DEFAULT_SIGNAL_STALE_MULTIPLIER);
  assert.equal(resolveSignalStaleMultiplier({ HEIMDALL_SIGNAL_STALE_MULTIPLIER: "nope" }), DEFAULT_SIGNAL_STALE_MULTIPLIER);
});

test("PANT-823: a suspect lane waiting on a known reset_at isn't stale before that time", () => {
  const base = { lastProbedAt: minutesAgo(120), expectedIntervalMs: HEALTHY_PROBE_INTERVAL_MS, multiplier: 3, now: NOW };
  const resetIn1h = new Date(NOW.getTime() + 60 * 60_000).toISOString();
  // The scheduler deliberately waits until reset_at before re-probing.
  assert.equal(computeSignalState({ ...base, status: "out_of_credit", resetAt: resetIn1h }), "fresh");
  // reset_at only matters while suspect — an up lane's leftover reset_at doesn't excuse a missed probe.
  assert.equal(computeSignalState({ ...base, status: "up", resetAt: resetIn1h }), "stale");
  // A reset_at long past no longer stretches the window.
  assert.equal(computeSignalState({ ...base, status: "out_of_credit", resetAt: minutesAgo(60) }), "stale");
});

test("PANT-823: expectedProbeIntervalMs follows the provider's backoff ceiling when it exceeds the healthy re-probe", () => {
  const store = new StateStore(":memory:");
  assert.equal(expectedProbeIntervalMs(store, "claude"), HEALTHY_PROBE_INTERVAL_MS);
  store.setSetting(BACKOFF_POLICY_SETTING_KEY, "exponential");
  store.setSetting(BACKOFF_EXPONENTIAL_CEILING_MS_SETTING_KEY, String(20 * 60_000));
  assert.equal(expectedProbeIntervalMs(store, "claude"), 20 * 60_000);
  store.close();
});
