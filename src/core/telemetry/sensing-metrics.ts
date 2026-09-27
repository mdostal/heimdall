// Sensing KPIs (PANT-824) — the counters behind GET /metrics' probe,
// transition and scheduler-start-failure families, plus GET /readyz's
// "did every lane's scheduler start" check.
//
// Every real Heimdall incident so far was a SENSING failure (probes never
// started — PANT-753; a quota error misclassified — PANT-729; lanes never
// probed at all — PANT-181) and none of them was visible in any metric.
// These counters make that class of failure scrapeable.
//
// Deliberately in-memory, per-process, rather than rows in telemetry_events:
// a suspect lane is refreshed every ~5s, so one row per probe would grow the
// table by tens of thousands of rows per lane per day for a number Prometheus
// only ever reads as a rate. Counters resetting on restart is the normal
// Prometheus counter contract (rate()/increase() handle resets). The one
// sensing fact that must survive a restart — when a lane was last observed —
// is read from lane_status_history instead (see metrics.ts), not kept here.

/** Histogram bucket upper bounds, seconds. A probe is one HTTP round-trip to a
 * provider (or a public status page), so sub-second through the ~30s fetch
 * timeout range covers it. */
export const PROBE_DURATION_BUCKETS_SECONDS: readonly number[] = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export type SchedulerKind = "in_process" | "multica_autopilot";

export interface ProbeObservation {
  lane: string;
  provider: string;
  /** Raw (pre-corroboration) verdict — up/down/out_of_credit/degraded — or "error" when the refresh itself threw. */
  result: string;
  /** Classified ErrorCode, "unconfigured", "exception", or "none". */
  errorCode: string;
  durationSeconds: number;
}

export interface SchedulerStartFailure {
  lane: string;
  scheduler: SchedulerKind;
  reason: string;
  occurredAt: string;
}

interface DurationHistogram {
  lane: string;
  provider: string;
  /** Non-cumulative per-bucket counts, parallel to PROBE_DURATION_BUCKETS_SECONDS; cumulated at render time. */
  bucketCounts: number[];
  sum: number;
  count: number;
}

// Label tuples are keyed with a separator that can't appear in a lane id
// taken from env/config in practice; split back apart on read.
const SEP = "\u0000";

export class SensingMetrics {
  private readonly probeCounts = new Map<string, number>();
  private readonly durations = new Map<string, DurationHistogram>();
  private readonly transitionCounts = new Map<string, number>();
  private readonly schedulerFailureCounts = new Map<string, number>();
  private readonly schedulerFailures: SchedulerStartFailure[] = [];

  constructor(private readonly nowImpl: () => string = () => new Date().toISOString()) {}

  recordProbe(obs: ProbeObservation): void {
    const key = [obs.lane, obs.provider, obs.result, obs.errorCode].join(SEP);
    this.probeCounts.set(key, (this.probeCounts.get(key) ?? 0) + 1);

    const durationKey = [obs.lane, obs.provider].join(SEP);
    let histogram = this.durations.get(durationKey);
    if (!histogram) {
      histogram = {
        lane: obs.lane,
        provider: obs.provider,
        bucketCounts: PROBE_DURATION_BUCKETS_SECONDS.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.durations.set(durationKey, histogram);
    }
    const bucketIndex = PROBE_DURATION_BUCKETS_SECONDS.findIndex((bound) => obs.durationSeconds <= bound);
    if (bucketIndex !== -1) histogram.bucketCounts[bucketIndex] += 1;
    histogram.sum += obs.durationSeconds;
    histogram.count += 1;
  }

  recordStatusTransition(lane: string, from: string, to: string): void {
    const key = [lane, from, to].join(SEP);
    this.transitionCounts.set(key, (this.transitionCounts.get(key) ?? 0) + 1);
  }

  recordSchedulerStartFailure(lane: string, scheduler: SchedulerKind, err: unknown): void {
    const key = [lane, scheduler].join(SEP);
    this.schedulerFailureCounts.set(key, (this.schedulerFailureCounts.get(key) ?? 0) + 1);
    this.schedulerFailures.push({
      lane,
      scheduler,
      reason: err instanceof Error ? err.message : String(err),
      occurredAt: this.nowImpl(),
    });
  }

  probeCounters(): Array<{ lane: string; provider: string; result: string; error_code: string; count: number }> {
    return [...this.probeCounts.entries()].map(([key, count]) => {
      const [lane, provider, result, error_code] = key.split(SEP);
      return { lane, provider, result, error_code, count };
    });
  }

  probeDurations(): Array<{
    lane: string;
    provider: string;
    /** Cumulative counts per upper bound, Prometheus `le` semantics, excluding +Inf (that's `count`). */
    buckets: Array<{ le: number; count: number }>;
    sum: number;
    count: number;
  }> {
    return [...this.durations.values()].map((h) => {
      let running = 0;
      const buckets = PROBE_DURATION_BUCKETS_SECONDS.map((le, i) => {
        running += h.bucketCounts[i];
        return { le, count: running };
      });
      return { lane: h.lane, provider: h.provider, buckets, sum: h.sum, count: h.count };
    });
  }

  transitionCounters(): Array<{ lane: string; from: string; to: string; count: number }> {
    return [...this.transitionCounts.entries()].map(([key, count]) => {
      const [lane, from, to] = key.split(SEP);
      return { lane, from, to, count };
    });
  }

  schedulerFailureCounters(): Array<{ lane: string; scheduler: string; count: number }> {
    return [...this.schedulerFailureCounts.entries()].map(([key, count]) => {
      const [lane, scheduler] = key.split(SEP);
      return { lane, scheduler, count };
    });
  }

  /** Every recorded start failure, oldest first — GET /readyz names the lanes from this. */
  listSchedulerStartFailures(): SchedulerStartFailure[] {
    return [...this.schedulerFailures];
  }
}
