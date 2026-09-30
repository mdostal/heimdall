// GET /readyz — readiness, as distinct from GET /healthz's liveness (PANT-824).
//
// /healthz answers "is the process up and serving HTTP" and stays static on
// purpose (the Tauri sidecar and Salus poll it at startup). /readyz answers
// "is Heimdall actually sensing": every past incident (PANT-753 probes never
// started, PANT-181 lanes never probed) left /healthz green while no lane
// was being observed. Reports `degraded` with named reasons when:
//
//   - any lane's scheduler failed to start (or the lane has no scheduler at
//     all because its provider has no adapters) — that lane is not sensed;
//   - the state DB can't be written — every probe result would be lost;
//   - no declared lane has been observed within the staleness window —
//     sensing as a whole has stalled. Per-lane staleness is left to
//     heimdall_lane_last_probe_age_seconds, since a healthy lane is only
//     re-probed every 5 minutes and a backed-off auth_failed lane even less.

import type { LaneRegistry } from "../core/lane-registry.js";
import type { StateStore } from "../core/state-store.js";
import type { SensingMetrics } from "../core/telemetry/sensing-metrics.js";

/** 3x the in-process scheduler's healthy re-probe interval (5 min), so one
 * slow or skipped refresh doesn't flip readiness. */
export const DEFAULT_READINESS_STALENESS_MS = 15 * 60_000;

export interface ReadinessCheck {
  ok: boolean;
  detail: string;
}

export interface ReadinessReport {
  status: "ready" | "degraded";
  reasons: string[];
  checks: {
    schedulers: ReadinessCheck & { failed_lanes: string[] };
    state_db: ReadinessCheck;
    probe_freshness: ReadinessCheck & { staleness_window_seconds: number; newest_probe_age_seconds: number | null };
  };
}

export function resolveReadinessStalenessMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.HEIMDALL_READINESS_STALENESS_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_READINESS_STALENESS_MS;
}

export function evaluateReadiness(input: {
  registry: LaneRegistry;
  store: StateStore;
  sensing?: SensingMetrics;
  stalenessMs?: number;
  now?: () => Date;
}): ReadinessReport {
  const stalenessMs = input.stalenessMs ?? DEFAULT_READINESS_STALENESS_MS;
  const nowMs = (input.now ?? (() => new Date()))().getTime();
  const reasons: string[] = [];

  const failures = input.sensing?.listSchedulerStartFailures() ?? [];
  const failedLanes = [...new Set(failures.map((f) => f.lane))];
  for (const f of failures) {
    reasons.push(`lane ${f.lane}: ${f.scheduler} scheduler failed to start — ${f.reason}`);
  }
  const schedulers = {
    ok: failures.length === 0,
    detail: failures.length === 0 ? "every lane's scheduler started" : `${failedLanes.length} lane(s) not scheduled as configured`,
    failed_lanes: failedLanes,
  };

  const writeError = input.store.checkWritable();
  if (writeError !== null) reasons.push(`state DB is not writable — ${writeError}`);
  const stateDb = { ok: writeError === null, detail: writeError ?? "writable" };

  const lanes = input.registry.list();
  let newestObservedMs: number | null = null;
  for (const lane of lanes) {
    if (!input.store.hasRecordedStatus(lane.lane_id)) continue;
    const observedMs = Date.parse(input.store.getCurrentStatus(lane.lane_id)?.last_updated ?? "");
    if (Number.isFinite(observedMs) && (newestObservedMs === null || observedMs > newestObservedMs)) {
      newestObservedMs = observedMs;
    }
  }
  const newestAgeSeconds = newestObservedMs === null ? null : Math.max(0, Math.round((nowMs - newestObservedMs) / 1000));
  let freshnessOk: boolean;
  let freshnessDetail: string;
  if (lanes.length === 0) {
    // Nothing declared, nothing to sense — a fresh install before any lane
    // is added isn't a sensing failure.
    freshnessOk = true;
    freshnessDetail = "no lanes declared";
  } else if (newestObservedMs === null) {
    freshnessOk = false;
    freshnessDetail = "no lane has ever been probed";
  } else if (nowMs - newestObservedMs > stalenessMs) {
    freshnessOk = false;
    freshnessDetail = `no lane probed in the last ${Math.round(stalenessMs / 1000)}s (newest observation ${newestAgeSeconds}s ago)`;
  } else {
    freshnessOk = true;
    freshnessDetail = `newest lane observation ${newestAgeSeconds}s ago`;
  }
  if (!freshnessOk) reasons.push(freshnessDetail);

  return {
    status: reasons.length === 0 ? "ready" : "degraded",
    reasons,
    checks: {
      schedulers,
      state_db: stateDb,
      probe_freshness: {
        ok: freshnessOk,
        detail: freshnessDetail,
        staleness_window_seconds: Math.round(stalenessMs / 1000),
        newest_probe_age_seconds: newestAgeSeconds,
      },
    },
  };
}
