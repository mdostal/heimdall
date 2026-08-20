// The default backoff policy (hdl-bp-02) — today's unchanged behavior:
// a flat interval regardless of how many consecutive suspect ticks have
// accumulated. Ignores `consecutiveSuspectTicks` and `config` entirely.

import type { BackoffContext, BackoffPolicy } from "./types.js";

export class StaticBackoff implements BackoffPolicy {
  readonly name = "static";

  nextDelayMs({ baseIntervalMs }: BackoffContext): number {
    return baseIntervalMs;
  }
}
