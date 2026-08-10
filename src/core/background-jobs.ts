import type { RotationController } from "./rotation-controller.js";

const DEFAULT_CAP_RESET_INTERVAL_MS = 5 * 60 * 1000;

export interface BackgroundJob {
  name: string;
  run(): string[];
}

export interface RunningBackgroundJob extends BackgroundJob {
  stop(): void;
}

export function createCapResetRecoveryJob(controller: RotationController): BackgroundJob {
  return {
    name: "cap-reset-recovery",
    run: () => controller.restoreExpiredCaps(),
  };
}

export function startCapResetRecoveryJob(
  controller: RotationController,
  options: { intervalMs?: number } = {},
): RunningBackgroundJob {
  const job = createCapResetRecoveryJob(controller);
  const timer = setInterval(job.run, options.intervalMs ?? DEFAULT_CAP_RESET_INTERVAL_MS);

  return {
    ...job,
    stop: () => clearInterval(timer),
  };
}
