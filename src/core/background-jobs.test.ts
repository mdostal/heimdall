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
  let calls = 0;
  const errors: unknown[] = [];
  const job = startBackgroundJob(
    {
      name: "always-throws",
      run: () => {
        calls += 1;
        throw new Error(`boom ${calls}`);
      },
    },
    { intervalMs: 5, onError: (err) => errors.push(err) },
  );

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
  } finally {
    job.stop();
  }

  assert.ok(calls >= 3, `expected the job to keep ticking after throwing, got ${calls} call(s)`);
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
