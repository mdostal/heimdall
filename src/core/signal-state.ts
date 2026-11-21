// PANT-823 — signal_state: tells "this lane is down" apart from "Heimdall
// has no signal for this lane". Both used to read as status:"down" — a
// never-probed lane falls back to down/unconfigured (REQ-07, state-store.ts)
// and a lane whose scheduler stopped keeps showing its last verdict forever.
// Pantheon's lane failover acts on those readings (PANT-763), so every lane
// view now carries signal_state + last_probed_at alongside the unchanged
// status. Additive only: `status` itself is never rewritten here.
//
//   never_probed — no observation has ever been recorded for the lane.
//   fresh        — the latest observation is within the staleness window.
//   stale        — the latest observation is older than N × the lane's
//                  expected probe interval (N = HEIMDALL_SIGNAL_STALE_MULTIPLIER,
//                  default 3).

import type { StateStore } from "./state-store.js";
import type { LaneStatusValue } from "./status-model.js";
import { AUTH_FAILED_BACKOFF_MS, DEFAULT_INTERVAL_MS, HEALTHY_PROBE_INTERVAL_MS } from "./scheduler/in-process-scheduler.js";
import {
  createBackoffPolicyRegistry,
  DEFAULT_BACKOFF_POLICY_NAME,
  getBackoffPolicyConfig,
  getBackoffPolicyNameForProvider,
} from "./scheduler/backoff-policies/registry.js";

export type SignalState = "never_probed" | "fresh" | "stale";

export const SIGNAL_STATES: readonly SignalState[] = ["never_probed", "fresh", "stale"];

/** Same 3x headroom as DEFAULT_READINESS_STALENESS_MS (readiness.ts): one slow or skipped refresh never flips a lane to stale. */
export const DEFAULT_SIGNAL_STALE_MULTIPLIER = 3;

export function resolveSignalStaleMultiplier(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.HEIMDALL_SIGNAL_STALE_MULTIPLIER);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SIGNAL_STALE_MULTIPLIER;
}

// A backoff policy's delay for a lane that has been suspect "forever" — its
// ceiling (exponential) or level cap (progressive). Static ignores the tick count.
const SATURATED_SUSPECT_TICKS = 1_000;

/**
 * The longest routine gap InProcessScheduler leaves between two refreshes of
 * a lane of this provider: the 5-minute healthy re-probe, the 5-minute
 * auth_failed backoff, or the active backoff policy's saturated delay,
 * whichever is longest. A known reset_at is handled separately by
 * computeSignalState, since it stretches one specific gap, not the cadence.
 */
export function expectedProbeIntervalMs(store: StateStore, provider: string): number {
  const policies = createBackoffPolicyRegistry();
  const policyName = getBackoffPolicyNameForProvider(store, provider);
  const policy = policies[policyName] ?? policies[DEFAULT_BACKOFF_POLICY_NAME];
  const backoffCeilingMs = policy.nextDelayMs({
    consecutiveSuspectTicks: SATURATED_SUSPECT_TICKS,
    baseIntervalMs: DEFAULT_INTERVAL_MS,
    config: getBackoffPolicyConfig(store, policyName),
  });
  return Math.max(
    HEALTHY_PROBE_INTERVAL_MS,
    AUTH_FAILED_BACKOFF_MS,
    Number.isFinite(backoffCeilingMs) ? backoffCeilingMs : 0,
  );
}

const SUSPECT_STATUSES: readonly LaneStatusValue[] = ["degraded", "down", "out_of_credit"];

/**
 * Pure classification. `resetAt` is the lane's effective reset time (manual
 * wins over sensed) and only counts while the lane is suspect: the scheduler
 * deliberately doesn't re-probe before it (in-process-scheduler.ts
 * computeDelayMs), so the staleness window starts from it, not from the
 * last observation.
 */
export function computeSignalState(input: {
  lastProbedAt: string | null;
  status: LaneStatusValue;
  resetAt: string | null;
  expectedIntervalMs: number;
  multiplier: number;
  now: Date;
}): SignalState {
  if (input.lastProbedAt === null) return "never_probed";
  const lastProbedMs = Date.parse(input.lastProbedAt);
  // An unparseable timestamp gives no evidence the lane is being observed.
  if (!Number.isFinite(lastProbedMs)) return "stale";
  const resetAtMs = input.resetAt !== null && SUSPECT_STATUSES.includes(input.status) ? Date.parse(input.resetAt) : NaN;
  const windowStartMs = Number.isFinite(resetAtMs) ? Math.max(lastProbedMs, resetAtMs) : lastProbedMs;
  return input.now.getTime() - windowStartMs > input.multiplier * input.expectedIntervalMs ? "stale" : "fresh";
}

export interface LaneSignal {
  signal_state: SignalState;
  /** Timestamp of the lane's most recent recorded observation (any signal source); null while never_probed. */
  last_probed_at: string | null;
}

export function getLaneSignal(
  store: StateStore,
  laneId: string,
  opts: { multiplier?: number; now?: Date } = {},
): LaneSignal {
  const current = store.hasRecordedStatus(laneId) ? store.getCurrentStatus(laneId) : null;
  if (current === null) return { signal_state: "never_probed", last_probed_at: null };
  return {
    signal_state: computeSignalState({
      lastProbedAt: current.last_updated,
      status: current.status,
      resetAt: store.getManualResetAt(laneId) ?? current.reset_at,
      expectedIntervalMs: expectedProbeIntervalMs(store, current.provider),
      multiplier: opts.multiplier ?? resolveSignalStaleMultiplier(),
      now: opts.now ?? new Date(),
    }),
    last_probed_at: current.last_updated,
  };
}
