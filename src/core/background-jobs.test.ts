import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startBackgroundJob,
  startHistoryRetentionJob,
  resolveRetentionDays,
  DEFAULT_RETENTION_DAYS,
} from "./background-jobs.js";
import { StateStore } from "./state-store.js";

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
