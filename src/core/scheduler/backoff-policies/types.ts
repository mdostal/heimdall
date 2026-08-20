// Shared backoff-policy contract (hdl-bp-02) — mirrors
// src/core/routing-strategies/types.ts's shape exactly (interface +
// one-file-per-implementation + registry factory), applied to the
// scheduler's probe-cadence backoff instead of route selection.
//
// This is a pure-function layer: no I/O, no scheduler coupling, no
// knowledge of `errorCode`/`resetAt`. Those two are pre-policy invariants
// (auth_failed's fixed backoff, a known resetAt's wait-until-it optimization)
// handled by the caller BEFORE a BackoffPolicy ever runs (hdl-bp-03) — every
// policy here only ever sees the "ordinary self-healing error, no known
// reset time" case.

export interface BackoffContext {
  /**
   * 1-indexed count of consecutive suspect ticks for the lane. The FIRST
   * tick a lane is found suspect passes 1, not 0 (the caller increments
   * before computing the delay, not after). This convention is load-bearing:
   * it's exactly what makes every policy's first suspect-tick delay equal
   * `baseIntervalMs` — matching `static`'s unconditional behavior — and is
   * why `exponential-progressive-backoff.ts` subtracts 1 from the exponent.
   */
  readonly consecutiveSuspectTicks: number;
  /** The flat interval a policy scales from (today's unconditional delay). */
  readonly baseIntervalMs: number;
  /** The policy's own resolved parameters (empty object for `static`). */
  readonly config: Record<string, unknown>;
}

export interface BackoffPolicy {
  readonly name: string;
  nextDelayMs(ctx: BackoffContext): number;
}

/** `progressive`'s config — linear step growth capped at `levelCap` (default 10). */
export interface ProgressiveConfig {
  levelCap: number;
}

/**
 * `exponential-progressive`'s config — multiplicative growth with a
 * mandatory ceiling. `ceilingMs` is REQUIRED, never optional: the operator's
 * explicit instruction was "say when to stop so put a limit on it" — an
 * unbounded exponential backoff was never on the table.
 */
export interface ExponentialConfig {
  multiplier: number;
  ceilingMs: number;
}
