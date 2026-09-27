import { test } from "node:test";
import assert from "node:assert/strict";
import { createCapResetRecoveryJob, startCapResetRecoveryJob } from "./background-jobs.js";
import type { RotationController } from "./rotation-controller.js";

// Only restoreExpiredCaps() is reached by these jobs; a counting stub keeps
// the tests on the scheduling behaviour itself. rotation-controller.test.ts
// covers what a real restore actually does to lane state.
function fakeController(): { controller: RotationController; calls: () => number } {
  let calls = 0;
  const controller = {
    restoreExpiredCaps: () => {
      calls += 1;
      return [`lane-${calls}`];
    },
  } as unknown as RotationController;
  return { controller, calls: () => calls };
}

test("background-jobs: createCapResetRecoveryJob is inert until run, and run delegates to restoreExpiredCaps", () => {
  const { controller, calls } = fakeController();
  const job = createCapResetRecoveryJob(controller);
  assert.equal(job.name, "cap-reset-recovery");
  assert.equal(calls(), 0);
  assert.deepEqual(job.run(), ["lane-1"]);
  assert.equal(calls(), 1);
});

test("background-jobs: startCapResetRecoveryJob ticks on the injected interval, not before", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { controller, calls } = fakeController();
  const job = startCapResetRecoveryJob(controller, { intervalMs: 1_000 });
  try {
    assert.equal(calls(), 0, "must not run immediately on start");
    t.mock.timers.tick(999);
    assert.equal(calls(), 0);
    t.mock.timers.tick(1);
    assert.equal(calls(), 1);
    t.mock.timers.tick(3_000);
    assert.equal(calls(), 4);
  } finally {
    job.stop();
  }
});

test("background-jobs: startCapResetRecoveryJob defaults to a 5-minute interval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { controller, calls } = fakeController();
  const job = startCapResetRecoveryJob(controller);
  try {
    t.mock.timers.tick(5 * 60 * 1000 - 1);
    assert.equal(calls(), 0);
    t.mock.timers.tick(1);
    assert.equal(calls(), 1);
  } finally {
    job.stop();
  }
});

test("background-jobs: stop() cancels every future tick", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { controller, calls } = fakeController();
  const job = startCapResetRecoveryJob(controller, { intervalMs: 1_000 });
  t.mock.timers.tick(1_000);
  assert.equal(calls(), 1);
  job.stop();
  t.mock.timers.tick(10_000);
  assert.equal(calls(), 1);
});

test("background-jobs: the running job can still be run by hand between ticks", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { controller, calls } = fakeController();
  const job = startCapResetRecoveryJob(controller, { intervalMs: 1_000 });
  try {
    assert.equal(job.name, "cap-reset-recovery");
    assert.deepEqual(job.run(), ["lane-1"]);
    t.mock.timers.tick(1_000);
    assert.equal(calls(), 2);
  } finally {
    job.stop();
  }
});
