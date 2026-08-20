// The "exponential-progressive" backoff policy (hdl-bp-02) — multiplicative
// growth per consecutive suspect tick, with a mandatory ceiling (the
// operator's explicit instruction: "say when to stop so put a limit on it"
// — unbounded exponential backoff was never on the table, so `ceilingMs`
// is a REQUIRED config field, not optional).
//
// Because `consecutiveSuspectTicks` is 1-indexed (see types.ts), the
// exponent uses `consecutiveSuspectTicks - 1`: the first suspect tick
// (consecutiveSuspectTicks = 1) yields exponent 0, i.e. exactly
// `baseIntervalMs * multiplier ** 0 === baseIntervalMs` — matching every
// other policy's first delay — and only diverges from tick 2 onward.

import type { BackoffContext, BackoffPolicy, ExponentialConfig } from "./types.js";

export class ExponentialProgressiveBackoff implements BackoffPolicy {
  readonly name = "exponential";

  nextDelayMs({ consecutiveSuspectTicks, baseIntervalMs, config }: BackoffContext): number {
    const { multiplier, ceilingMs } = config as unknown as ExponentialConfig;
    const raw = baseIntervalMs * multiplier ** (consecutiveSuspectTicks - 1);
    return Math.min(raw, ceilingMs);
  }
}
