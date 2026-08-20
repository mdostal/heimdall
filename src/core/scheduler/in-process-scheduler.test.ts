import { test } from "node:test";
import assert from "node:assert/strict";
import { InProcessScheduler } from "./in-process-scheduler.js";
import { StateStore } from "../state-store.js";
import type { Lane } from "../lane-registry.js";
import type { ArgusEmitter } from "../telemetry/argus-client.js";
import type { LanePipeline } from "../lane-pipeline.js";

const LANE: Lane = {
  lane_id: "claude@mathew.dostal",
  provider: "claude",
  credential_ref: "CLAUDE_TOKEN",
  credential: "fake",
};

function fakeArgus(): ArgusEmitter & { ticks: unknown[]; flips: unknown[] } {
  const ticks: unknown[] = [];
  const flips: unknown[] = [];
  return {
    ticks,
    flips,
    emitTick: (params) => ticks.push(params),
    emitStatusFlip: (params) => flips.push(params),
    emitActuationResult: () => {},
  };
}

function fakePipeline(refresh: (lane: Lane) => Promise<void>): LanePipeline {
  return { refresh } as unknown as LanePipeline;
}

function seedStore(
  status: "up" | "down" | "degraded" | "out_of_credit",
  reset_at: string | null = null,
  error_code: "rate_limit" | "quota_exceeded" | "billing_error" | "auth_failed" | "server_error" | "network_error" | "unknown" | null = null,
): StateStore {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: LANE.lane_id, provider: LANE.provider, credential_ref: LANE.credential_ref });
  store.recordStatus({
    lane_id: LANE.lane_id,
    status,
    reset_at,
    reason: null,
    error_code,
    signal_source: "active_probe",
    observed_at: "2026-07-25T12:00:00.000Z",
  });
  return store;
}

test("engages (calls refresh) when the lane is suspect", async () => {
  const store = seedStore("degraded");
  let refreshCalled = false;
  const pipeline = fakePipeline(async () => {
    refreshCalled = true;
  });
  const scheduler = new InProcessScheduler({ lane: LANE, pipeline, store, argus: fakeArgus() });

  await scheduler.poll();

  assert.equal(refreshCalled, true);
  store.close();
});

test("does NOT engage (does not call refresh) when the lane is healthy", async () => {
  const store = seedStore("up");
  let refreshCalled = false;
  const pipeline = fakePipeline(async () => {
    refreshCalled = true;
  });
  const scheduler = new InProcessScheduler({ lane: LANE, pipeline, store, argus: fakeArgus() });

  await scheduler.poll();

  assert.equal(refreshCalled, false);
  store.close();
});

test("engages for down and out_of_credit too, not just degraded", async () => {
  for (const status of ["down", "out_of_credit"] as const) {
    const store = seedStore(status);
    let refreshCalled = false;
    const pipeline = fakePipeline(async () => {
      refreshCalled = true;
    });
    const scheduler = new InProcessScheduler({ lane: LANE, pipeline, store, argus: fakeArgus() });
    await scheduler.poll();
    assert.equal(refreshCalled, true, `expected engagement for status=${status}`);
    store.close();
  }
});

test("overlap guard: a second poll while a refresh is in-flight does not call refresh again", async () => {
  const store = seedStore("degraded");
  let refreshCallCount = 0;
  let resolveFirst: () => void = () => {};
  const pipeline = fakePipeline(async () => {
    refreshCallCount += 1;
    await new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
  });
  const scheduler = new InProcessScheduler({ lane: LANE, pipeline, store, argus: fakeArgus() });

  const firstPoll = scheduler.poll(); // starts, refresh in-flight, awaiting resolveFirst
  await Promise.resolve(); // let the first poll reach the in-flight await
  const secondPoll = scheduler.poll(); // should skip — refresh already in-flight

  resolveFirst();
  await firstPoll;
  await secondPoll;

  assert.equal(refreshCallCount, 1);
  store.close();
});

test("a throwing refresh() is caught, isolated, and does not prevent future scheduling", async () => {
  const store = seedStore("down");
  const errors: unknown[] = [];
  const pipeline = fakePipeline(async () => {
    throw new Error("provider unreachable");
  });
  let scheduleCount = 0;
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline,
    store,
    argus: fakeArgus(),
    onError: (err) => errors.push(err),
    setTimeoutImpl: ((fn: () => void, _ms: number) => {
      scheduleCount += 1;
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start(); // schedules first timer (does not run poll yet)
  await scheduler.poll(); // manually drive one poll cycle, simulating the timer firing

  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /provider unreachable/);
  assert.ok(scheduleCount >= 2, "expected scheduling to continue after the error (start() + poll()'s own reschedule)");
  store.close();
});

test("emits a tick to Argus when it engages", async () => {
  const store = seedStore("degraded");
  const argus = fakeArgus();
  const pipeline = fakePipeline(async () => {});
  const scheduler = new InProcessScheduler({ lane: LANE, pipeline, store, argus });

  await scheduler.poll();

  assert.equal(argus.ticks.length, 1);
  assert.deepEqual(argus.ticks[0], {
    laneId: LANE.lane_id,
    provider: LANE.provider,
    source: "in_process_scheduler",
  });
  store.close();
});

test("emits a status-flip to Argus when refresh() changes the lane's status", async () => {
  const store = seedStore("down");
  const argus = fakeArgus();
  const pipeline = fakePipeline(async (lane) => {
    store.recordStatus({
      lane_id: lane.lane_id,
      status: "up",
      reset_at: null,
      reason: null,
      signal_source: "active_probe",
      observed_at: "2026-07-25T12:00:05.000Z",
    });
  });
  const scheduler = new InProcessScheduler({ lane: LANE, pipeline, store, argus });

  await scheduler.poll();

  assert.equal(argus.flips.length, 1);
  assert.deepEqual(argus.flips[0], {
    laneId: LANE.lane_id,
    provider: LANE.provider,
    from: "down",
    to: "up",
  });
  store.close();
});

test("does not emit a status-flip when status is unchanged after refresh", async () => {
  const store = seedStore("degraded");
  const argus = fakeArgus();
  const pipeline = fakePipeline(async (lane) => {
    store.recordStatus({
      lane_id: lane.lane_id,
      status: "degraded",
      reset_at: null,
      reason: "still degraded",
      signal_source: "active_probe",
      observed_at: "2026-07-25T12:00:05.000Z",
    });
  });
  const scheduler = new InProcessScheduler({ lane: LANE, pipeline, store, argus });

  await scheduler.poll();

  assert.equal(argus.flips.length, 0);
  store.close();
});

test("stop() prevents further polling from being scheduled", async () => {
  const store = seedStore("up");
  let scheduleCount = 0;
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    setTimeoutImpl: ((fn: () => void) => {
      scheduleCount += 1;
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start();
  assert.equal(scheduleCount, 1);
  scheduler.stop();
  await scheduler.poll(); // even if driven manually, poll() itself checks `stopped`
  assert.equal(scheduleCount, 1, "no further scheduling after stop()");
  store.close();
});

test("stop() cancels the real underlying timer even after a manual poll() rescheduled it (no leaked timer)", async () => {
  // Regression test: start() schedules a real timer; a manually-invoked
  // poll() (as other tests do for determinism) used to overwrite `this.timer`
  // WITHOUT cancelling the original underlying timer, leaking it to fire
  // later regardless of a subsequent stop() call.
  const store = seedStore("up");
  const clearedTimers: unknown[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    setTimeoutImpl: ((fn: () => void) => Symbol("timer")) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((handle: unknown) => {
      clearedTimers.push(handle);
    }) as typeof clearTimeout,
  });

  scheduler.start(); // schedules timer A
  await scheduler.poll(); // manually driven — must cancel timer A before scheduling timer B
  scheduler.stop(); // must cancel timer B

  assert.equal(clearedTimers.length, 2, "both the original and the rescheduled timer must be cleared");
  store.close();
});

test("reset_at-aware delay: schedules the next poll at reset_at, not the flat interval, when reset_at is known and in the future", async () => {
  // Lane stays suspect after refresh (pipeline doesn't change status) with a
  // reset_at 30 minutes past "now" (nowImpl below) — the next scheduled
  // delay should reflect that ~30min wait, not the 5s default.
  const store = seedStore("out_of_credit", "2026-07-25T12:30:00.000Z");
  const delays: number[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    nowImpl: () => "2026-07-25T12:00:00.000Z",
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      delays.push(ms);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start(); // schedules delays[0] with the default interval (unrelated to this test)
  await scheduler.poll(); // manually driven — schedules delays[1], the one under test

  assert.equal(delays.length, 2);
  assert.equal(delays[1], 30 * 60 * 1000, "expected the delay to equal reset_at - now (30 minutes)");
  store.close();
});

test("reset_at-aware delay: falls back to the flat interval when reset_at is null (unknown-reason down)", async () => {
  const store = seedStore("down", null);
  const delays: number[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      delays.push(ms);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start();
  await scheduler.poll();

  assert.equal(delays.length, 2);
  assert.equal(delays[1], 5_000, "expected the existing flat DEFAULT_INTERVAL_MS when reset_at is unknown");
  store.close();
});

test("reset_at-aware delay: clamps to the flat interval floor when reset_at is in the past (clock skew / stale data)", async () => {
  const store = seedStore("out_of_credit", "2026-07-25T11:00:00.000Z"); // 1h in the past relative to nowImpl below
  const delays: number[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    nowImpl: () => "2026-07-25T12:00:00.000Z",
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      delays.push(ms);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start();
  await scheduler.poll();

  assert.equal(delays.length, 2);
  assert.equal(delays[1], 5_000, "a past reset_at must clamp to the flat interval floor, never negative/zero");
  store.close();
});

test("reset_at-aware delay: a lane that recovers to healthy reverts to the flat interval regardless of the prior reset_at", async () => {
  const store = seedStore("out_of_credit", "2026-07-25T18:00:00.000Z"); // far future — would dominate if not for recovery
  const pipeline = fakePipeline(async (lane) => {
    store.recordStatus({
      lane_id: lane.lane_id,
      status: "up",
      reset_at: null,
      reason: null,
      signal_source: "active_probe",
      observed_at: "2026-07-25T12:00:05.000Z",
    });
  });
  const delays: number[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline,
    store,
    argus: fakeArgus(),
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      delays.push(ms);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start();
  await scheduler.poll();

  assert.equal(delays.length, 2);
  assert.equal(delays[1], 5_000, "a recovered (healthy) lane always gets the flat interval, unaffected by the pre-recovery reset_at");
  store.close();
});

test("hdl-error-taxonomy: an auth_failed lane backs off to the fixed long interval, not the flat 5s or a (nonexistent) reset_at", async () => {
  const store = seedStore("down", null, "auth_failed");
  const delays: number[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    nowImpl: () => "2026-07-25T12:00:00.000Z",
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      delays.push(ms);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start();
  await scheduler.poll();

  assert.equal(delays.length, 2);
  assert.equal(delays[1], 5 * 60_000, "expected the fixed 5-minute auth_failed backoff, not the flat 5s interval");
  store.close();
});

test("hdl-error-taxonomy: a suspect lane with any OTHER error_code is unaffected — still gets the flat interval when reset_at is unknown", async () => {
  const store = seedStore("degraded", null, "rate_limit");
  const delays: number[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    nowImpl: () => "2026-07-25T12:00:00.000Z",
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      delays.push(ms);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start();
  await scheduler.poll();

  assert.equal(delays.length, 2);
  assert.equal(delays[1], 5_000, "rate_limit (and every other non-auth_failed code) must not trigger the backoff — the SLA-driven fine cadence still applies");
  store.close();
});

test("hdl-error-taxonomy: an operator's manual_reset_at wins outright over the auth_failed backoff", async () => {
  const store = seedStore("down", null, "auth_failed");
  store.setManualResetAt(LANE.lane_id, "2026-07-25T12:10:00.000Z"); // operator: "I'll fix this in 10 minutes"
  const delays: number[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    nowImpl: () => "2026-07-25T12:00:00.000Z",
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      delays.push(ms);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start();
  await scheduler.poll();

  assert.equal(delays.length, 2);
  assert.equal(delays[1], 10 * 60_000, "the operator's explicit manual_reset_at (10 minutes) must win over the automatic 5-minute auth_failed backoff");
  store.close();
});

test("hdl-lm-03: manual_reset_at wins over the sensed reset_at when set", async () => {
  const store = seedStore("out_of_credit", "2026-07-25T12:05:00.000Z"); // sensed reset_at: 5 min out
  store.setManualResetAt(LANE.lane_id, "2026-07-25T13:00:00.000Z"); // manual: 1 hour out
  const delays: number[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    nowImpl: () => "2026-07-25T12:00:00.000Z",
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      delays.push(ms);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start();
  await scheduler.poll();

  assert.equal(delays.length, 2);
  assert.equal(delays[1], 60 * 60 * 1000, "expected the manual_reset_at (1 hour) to win over the sensed reset_at (5 minutes)");
  store.close();
});

test("hdl-lm-03: byte-identical to pre-hdl-lm-03 behavior when manual_reset_at is unset (null)", async () => {
  const store = seedStore("out_of_credit", "2026-07-25T12:30:00.000Z");
  // no setManualResetAt call — stays null
  const delays: number[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    nowImpl: () => "2026-07-25T12:00:00.000Z",
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      delays.push(ms);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start();
  await scheduler.poll();

  assert.equal(delays.length, 2);
  assert.equal(delays[1], 30 * 60 * 1000, "expected the sensed reset_at (30 minutes) to decide, unchanged from hdl-rar-01 behavior");
  store.close();
});

test("hdl-lm-03: clearing manual_reset_at (set back to null) reverts to the sensed reset_at", async () => {
  const store = seedStore("out_of_credit", "2026-07-25T12:10:00.000Z"); // sensed: 10 min out
  store.setManualResetAt(LANE.lane_id, "2026-07-25T18:00:00.000Z"); // manual: far out
  store.setManualResetAt(LANE.lane_id, null); // cleared
  const delays: number[] = [];
  const scheduler = new InProcessScheduler({
    lane: LANE,
    pipeline: fakePipeline(async () => {}),
    store,
    argus: fakeArgus(),
    nowImpl: () => "2026-07-25T12:00:00.000Z",
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      delays.push(ms);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });

  scheduler.start();
  await scheduler.poll();

  assert.equal(delays.length, 2);
  assert.equal(delays[1], 10 * 60 * 1000, "expected the sensed reset_at (10 minutes) to decide once the manual override was cleared");
  store.close();
});

test("hdl-bp-03: consecutiveSuspectTicks increments while suspect, resets to exactly 0 the instant the lane recovers, and restarts at 1 on the next suspect tick", async () => {
  // This is the epic's single highest-risk property (docs/scheduler-
  // constraints.md's "backs off immediately on recovery" guarantee):
  // simulates suspect -> suspect -> healthy -> suspect again, asserting the
  // counter at every step, not just inferring it indirectly through delays.
  const store = seedStore("degraded"); // no reset_at, no error_code
  const pipeline = fakePipeline(async () => {}); // no-op: does not itself change status
  const scheduler = new InProcessScheduler({ lane: LANE, pipeline, store, argus: fakeArgus() });

  await scheduler.poll(); // 1st consecutive suspect tick
  assert.equal(scheduler.consecutiveSuspectTicks, 1, "first suspect tick must be 1 (1-indexed), not 0");

  await scheduler.poll(); // 2nd consecutive suspect tick
  assert.equal(scheduler.consecutiveSuspectTicks, 2, "second consecutive suspect tick must be 2");

  // Simulate recovery (as a real refresh() would do by writing a new status).
  store.recordStatus({
    lane_id: LANE.lane_id,
    status: "up",
    reset_at: null,
    reason: null,
    error_code: null,
    signal_source: "active_probe",
    observed_at: "2026-07-25T12:00:10.000Z",
  });
  await scheduler.poll();
  assert.equal(
    scheduler.consecutiveSuspectTicks,
    0,
    "consecutiveSuspectTicks must reset to exactly 0 the instant the lane is no longer suspect, not decrement or hold",
  );

  // Simulate a fresh degradation after the healthy interlude.
  store.recordStatus({
    lane_id: LANE.lane_id,
    status: "degraded",
    reset_at: null,
    reason: null,
    error_code: null,
    signal_source: "active_probe",
    observed_at: "2026-07-25T12:00:15.000Z",
  });
  await scheduler.poll();
  assert.equal(scheduler.consecutiveSuspectTicks, 1, "the next suspect tick after recovery must restart at 1, not continue from the pre-recovery count");

  store.close();
});
