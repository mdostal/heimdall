// InProcessScheduler — fine ~5s ticker, suspect-lane only (hdl-02).
// See docs/scheduler-constraints.md: "the service's own event loop, NOT a
// standalone cron/launchd/shell daemon" — legitimate specifically because
// it's narrowly scoped (only calls LanePipeline.refresh() while a lane is
// suspect) and stops doing that expensive work the instant the lane
// recovers. The lightweight local-status poll itself keeps running (cheap
// SQLite read, no network/token cost) so a re-degradation is still caught —
// what "disengages" on recovery is the actual refresh() invocation, not the
// poll loop's existence.

import type { Scheduler } from "./scheduler.js";
import type { LanePipeline } from "../lane-pipeline.js";
import type { StateStore } from "../state-store.js";
import type { Lane } from "../lane-registry.js";
import type { ArgusEmitter } from "../telemetry/argus-client.js";
import type { LaneStatusValue } from "../status-model.js";

const SUSPECT_STATUSES: readonly LaneStatusValue[] = ["degraded", "down", "out_of_credit"];

export interface InProcessSchedulerOptions {
  lane: Lane;
  pipeline: LanePipeline;
  store: StateStore;
  argus: ArgusEmitter;
  intervalMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  onError?: (err: unknown, lane: Lane) => void;
  /** Injected clock — an ISO-8601 timestamp for "now". Never Date.now() internally (matches lane-pipeline.ts's convention). */
  nowImpl?: () => string;
}

const DEFAULT_INTERVAL_MS = 5_000;

export class InProcessScheduler implements Scheduler {
  private readonly intervalMs: number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly onError: (err: unknown, lane: Lane) => void;
  private readonly nowImpl: () => string;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private refreshInFlight = false;
  private lastKnownStatus: LaneStatusValue | null = null;

  constructor(private readonly opts: InProcessSchedulerOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;
    this.onError = opts.onError ?? ((err) => console.error("[in-process-scheduler] tick failed:", err));
    this.nowImpl = opts.nowImpl ?? (() => new Date().toISOString());
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext(this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
  }

  /**
   * reset_at-aware delay: when a known future reset_at exists, wait until
   * (or shortly after) it instead of the flat interval — no point probing a
   * lane we already know won't recover until a specific time. Floored at
   * this.intervalMs so a past/near/malformed reset_at (clock skew, stale
   * data) can never produce a zero/negative/busy-loop delay. No ceiling —
   * a reset_at far in the future is honored in full, that's the point.
   */
  private computeDelayMs(resetAt: string | null): number {
    if (!resetAt) return this.intervalMs;
    const resetAtMs = Date.parse(resetAt);
    if (Number.isNaN(resetAtMs)) return this.intervalMs;
    const nowMs = Date.parse(this.nowImpl());
    return Math.max(this.intervalMs, resetAtMs - nowMs);
  }

  private scheduleNext(delayMs: number): void {
    // Always clear any existing timer first — poll() can be invoked
    // manually (tests do this for determinism) while start()'s own timer is
    // still pending; without this, the manual call's reschedule overwrites
    // `this.timer`'s reference without cancelling the original underlying
    // timer, leaking it to fire later regardless of subsequent stop() calls.
    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
    if (this.stopped) return;
    this.timer = this.setTimeoutImpl(() => {
      void this.poll();
    }, delayMs);
  }

  /**
   * Exposed for tests to drive one poll cycle deterministically without
   * waiting on real timers. Intentionally does NOT gate on `this.stopped` —
   * a manually-invoked poll() should always execute; it's scheduleNext()'s
   * job (below) to stop future automatic scheduling after stop().
   */
  async poll(): Promise<void> {
    const current = this.opts.store.getCurrentStatus(this.opts.lane.lane_id);
    const isSuspect = current !== null && SUSPECT_STATUSES.includes(current.status);

    if (isSuspect && !this.refreshInFlight) {
      const beforeStatus = current!.status;
      this.refreshInFlight = true;
      try {
        await this.opts.pipeline.refresh(this.opts.lane);
        this.opts.argus.emitTick({
          laneId: this.opts.lane.lane_id,
          provider: this.opts.lane.provider,
          source: "in_process_scheduler",
        });

        const after = this.opts.store.getCurrentStatus(this.opts.lane.lane_id);
        if (after && after.status !== beforeStatus) {
          this.opts.argus.emitStatusFlip({
            laneId: this.opts.lane.lane_id,
            provider: this.opts.lane.provider,
            from: beforeStatus,
            to: after.status,
          });
        }
      } catch (err) {
        // One bad tick must not wedge the loop — caught here, next poll still scheduled.
        this.onError(err, this.opts.lane);
      } finally {
        this.refreshInFlight = false;
      }
    }
    // Lane is healthy (or a refresh is already in-flight — overlap guard):
    // no refresh() call this cycle. This IS the "backs off when healthy"
    // behavior — the expensive work (refresh) stops immediately; only the
    // cheap local status read continues.

    // Re-read after any refresh() above so a fresh reset_at (or recovery)
    // informs the NEXT delay. A healthy lane always gets the flat interval
    // — reset_at only matters while still suspect.
    const latest = this.opts.store.getCurrentStatus(this.opts.lane.lane_id);
    const stillSuspect = latest !== null && SUSPECT_STATUSES.includes(latest.status);
    // hdl-lm-03: an operator-supplied manual_reset_at ("change the times")
    // wins over the sensed reset_at, same precedence as manual_override
    // wins over sensed status in MulticaControlAdapter — scheduling-only,
    // does not touch ReconcileContext/ControlAdapter/Argus.
    const manualResetAt = this.opts.store.getManualResetAt(this.opts.lane.lane_id);
    const delayMs = stillSuspect ? this.computeDelayMs(manualResetAt ?? latest!.reset_at) : this.intervalMs;
    this.scheduleNext(delayMs);
  }
}
