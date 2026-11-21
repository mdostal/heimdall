import type { RotationController } from "./rotation-controller.js";
import type { StateStore } from "./state-store.js";

const DEFAULT_CAP_RESET_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackgroundJob {
  name: string;
  run(): unknown;
}

export interface RunningBackgroundJob extends BackgroundJob {
  stop(): void;
}

export interface StartBackgroundJobOptions {
  intervalMs: number;
  /** Also run once synchronously at start (still guarded), not only on the first tick. */
  runImmediately?: boolean;
  onError?: (err: unknown) => void;
}

/**
 * PANT-829: every background job runs through this guard. A bare
 * `setInterval(job.run, …)` turns one thrown error (e.g. a transient
 * SQLITE_BUSY) into an uncaught exception that kills the whole service;
 * here it is logged and the next tick runs as normal. The timer is unref'd
 * so a background job alone never keeps the process alive.
 */
export function startBackgroundJob(job: BackgroundJob, options: StartBackgroundJobOptions): RunningBackgroundJob {
  const onError =
    options.onError ?? ((err: unknown) => console.error(`[background-jobs] job "${job.name}" failed:`, err));
  const guardedRun = (): void => {
    try {
      job.run();
    } catch (err) {
      onError(err);
    }
  };

  if (options.runImmediately) guardedRun();
  const timer = setInterval(guardedRun, options.intervalMs);
  timer.unref?.();

  return {
    ...job,
    stop: () => clearInterval(timer),
  };
}

export function createCapResetRecoveryJob(controller: RotationController): BackgroundJob {
  return {
    name: "cap-reset-recovery",
    run: () => controller.restoreExpiredCaps(),
  };
}

export function startCapResetRecoveryJob(
  controller: RotationController,
  options: { intervalMs?: number; onError?: (err: unknown) => void } = {},
): RunningBackgroundJob {
  return startBackgroundJob(createCapResetRecoveryJob(controller), {
    intervalMs: options.intervalMs ?? DEFAULT_CAP_RESET_INTERVAL_MS,
    onError: options.onError,
  });
}

/**
 * HEIMDALL_RETENTION_DAYS (default 30). Anything that isn't a positive
 * number falls back to the default with a warning rather than disabling
 * retention or crashing startup.
 */
export function resolveRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HEIMDALL_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    console.warn(
      `[background-jobs] invalid HEIMDALL_RETENTION_DAYS="${raw}" — using default ${DEFAULT_RETENTION_DAYS}.`,
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return days;
}

export function createHistoryRetentionJob(
  store: StateStore,
  options: { retentionDays: number; now?: () => Date },
): BackgroundJob {
  const now = options.now ?? (() => new Date());
  return {
    name: "history-retention",
    run: () => {
      const cutoff = new Date(now().getTime() - options.retentionDays * DAY_MS).toISOString();
      return store.pruneHistoryOlderThan(cutoff);
    },
  };
}

/** Prunes lane_status_history/telemetry_events at startup and then daily. */
export function startHistoryRetentionJob(
  store: StateStore,
  options: { retentionDays: number; intervalMs?: number; now?: () => Date; onError?: (err: unknown) => void },
): RunningBackgroundJob {
  return startBackgroundJob(createHistoryRetentionJob(store, options), {
    intervalMs: options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS,
    runImmediately: true,
    onError: options.onError,
  });
}
