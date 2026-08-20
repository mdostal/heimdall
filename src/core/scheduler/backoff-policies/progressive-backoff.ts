// The "progressive" backoff policy (hdl-bp-02) — linear step growth per
// consecutive suspect tick, capped at `levelCap` (default 10). Because
// `consecutiveSuspectTicks` is 1-indexed (see types.ts), the first suspect
// tick yields exactly `baseIntervalMs`, matching `static`'s first delay.

import type { BackoffContext, BackoffPolicy, ProgressiveConfig } from "./types.js";

const DEFAULT_LEVEL_CAP = 10;

export class ProgressiveBackoff implements BackoffPolicy {
  readonly name = "progressive";

  nextDelayMs({ consecutiveSuspectTicks, baseIntervalMs, config }: BackoffContext): number {
    const levelCap = (config as Partial<ProgressiveConfig>).levelCap ?? DEFAULT_LEVEL_CAP;
    return baseIntervalMs * Math.min(consecutiveSuspectTicks, levelCap);
  }
}
