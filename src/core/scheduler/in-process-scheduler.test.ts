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

function seedStore(status: "up" | "down" | "degraded" | "out_of_credit"): StateStore {
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: LANE.lane_id, provider: LANE.provider, credential_ref: LANE.credential_ref });
  store.recordStatus({
    lane_id: LANE.lane_id,
    status,
    reset_at: null,
    reason: null,
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
