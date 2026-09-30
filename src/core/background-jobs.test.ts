import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCapResetRecoveryJob,
  startCapResetRecoveryJob,
  startBackgroundJob,
  startHistoryRetentionJob,
  resolveRetentionDays,
  DEFAULT_RETENTION_DAYS,
} from "./background-jobs.js";
import { StateStore } from "./state-store.js";
import type { RotationController } from "./rotation-controller.js";

test("PANT-829: a background job that throws is logged and the next tick still runs", async () => {
  // Wait for three ticks rather than a fixed wall-clock window, so a slow
  // event loop can't make this flaky; the timeout only bounds a real hang.
  const TARGET_TICKS = 3;
  let calls = 0;
  const errors: unknown[] = [];
  let reachedTarget!: () => void;
  const ticked = new Promise<void>((resolve) => {
    reachedTarget = resolve;
  });
  const job = startBackgroundJob(
    {
      name: "always-throws",
      run: () => {
        calls += 1;
        throw new Error(`boom ${calls}`);
      },
    },
    {
      intervalMs: 5,
      onError: (err) => {
        errors.push(err);
        if (errors.length === TARGET_TICKS) reachedTarget();
      },
    },
  );

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      ticked,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`expected the job to keep ticking after throwing, got ${calls} call(s)`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    job.stop();
  }

  assert.ok(calls >= TARGET_TICKS);
  assert.equal(errors.length, calls, "every thrown error must reach onError, none escape as uncaught");
  assert.match(String(errors[0]), /boom 1/);
});

test("PANT-829: runImmediately runs the job once at start, guarded", () => {
  let calls = 0;
  const errors: unknown[] = [];
  const job = startBackgroundJob(
    {
      name: "throws-at-start",
      run: () => {
        calls += 1;
        throw new Error("startup failure");
      },
    },
    { intervalMs: 60_000, runImmediately: true, onError: (err) => errors.push(err) },
  );
  job.stop();
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
});

test("PANT-829: resolveRetentionDays defaults to 30 and rejects non-positive/non-numeric values", () => {
  assert.equal(resolveRetentionDays({}), DEFAULT_RETENTION_DAYS);
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
  assert.equal(resolveRetentionDays({ HEIMDALL_RETENTION_DAYS: "7" }), 7);
  assert.equal(resolveRetentionDays({ HEIMDALL_RETENTION_DAYS: "0" }), DEFAULT_RETENTION_DAYS);
  assert.equal(resolveRetentionDays({ HEIMDALL_RETENTION_DAYS: "-3" }), DEFAULT_RETENTION_DAYS);
  assert.equal(resolveRetentionDays({ HEIMDALL_RETENTION_DAYS: "soon" }), DEFAULT_RETENTION_DAYS);
});

test("PANT-829: the retention job prunes at startup using now - retentionDays as the cutoff", () => {
  const store = new StateStore(":memory:");
  store.recordTelemetryEvent("probe", { lane: "a" }, "2026-01-01T00:00:00.000Z"); // 40 days old
  store.recordTelemetryEvent("probe", { lane: "a" }, "2026-02-01T00:00:00.000Z"); // 9 days old

  const job = startHistoryRetentionJob(store, {
    retentionDays: 30,
    now: () => new Date("2026-02-10T00:00:00.000Z"),
  });
  job.stop();

  const remaining = store.listRecentTelemetryEvents(10).map((e) => e.occurred_at);
  assert.deepEqual(remaining, ["2026-02-01T00:00:00.000Z"]);
  store.close();
});

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
