// GET /metrics — Prometheus text exposition format (hdl-ot-03), hand-rolled,
// no new dependency. Aggregates entirely from Heimdall's own local state
// (StateStore, the routing-decision ledger, and the in-process
// SensingMetrics counters — PANT-824) — this is the "silo" surface:
// scrapable by Argus, Grafana, Prometheus, or anything else OTEL/Prometheus-
// compatible later, without Heimdall depending on any of them being present.

import type { LaneRegistry } from "../core/lane-registry.js";
import type { StateStore } from "../core/state-store.js";
import { getRoutingDecisionCounts } from "../core/route-selector.js";
import type { SensingMetrics } from "../core/telemetry/sensing-metrics.js";
import { getLaneSignal, resolveSignalStaleMultiplier, SIGNAL_STATES } from "../core/signal-state.js";

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

interface MetricFamily {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  /** `suffix` is appended to the family name — histograms' _bucket/_sum/_count series. */
  samples: Array<{ labels: Record<string, string>; value: number; suffix?: string }>;
}

// Plain decimal, never exponent notation (String(1e-7) === "1e-7") — keeps
// every sample matching the dashboard's simple line regex.
function formatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function renderFamily(family: MetricFamily): string {
  const lines = [`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} ${family.type}`];
  for (const sample of family.samples) {
    lines.push(`${family.name}${sample.suffix ?? ""}${formatLabels(sample.labels)} ${formatValue(sample.value)}`);
  }
  return lines.join("\n");
}

/**
 * `sensing` is the service-wide SensingMetrics instance (PANT-824) — omitted
 * by callers with no running pipelines, in which case the probe/transition/
 * scheduler-failure families render with no samples. `now` is injectable so
 * tests can pin heimdall_lane_last_probe_age_seconds.
 */
export function renderMetrics(
  registry: LaneRegistry,
  store: StateStore,
  sensing?: SensingMetrics,
  now: () => Date = () => new Date(),
  signalStaleMultiplier: number = resolveSignalStaleMultiplier(),
): string {
  // PANT-823: a never-probed lane is counted as status="unknown", not
  // "down" — its "down" is StateStore's REQ-07 no-signal fallback, not an
  // observed outage. GET /lanes still reports it as down + never_probed.
  const laneCountsByProviderStatus = new Map<string, number>();
  for (const lane of registry.list()) {
    const status = store.hasRecordedStatus(lane.lane_id)
      ? (store.getCurrentStatus(lane.lane_id)?.status ?? "unknown")
      : "unknown";
    const key = `${lane.provider}\u0000${status}`;
    laneCountsByProviderStatus.set(key, (laneCountsByProviderStatus.get(key) ?? 0) + 1);
  }

  const lanesFamily: MetricFamily = {
    name: "heimdall_lanes",
    help: "Current number of declared lanes by provider and status.",
    type: "gauge",
    samples: [...laneCountsByProviderStatus.entries()].map(([key, value]) => {
      const [provider, status] = key.split("\u0000");
      return { labels: { provider, status }, value };
    }),
  };

  // PANT-824: heimdall_actuation_results_total was removed — every lane's
  // ControlAdapter is StubControlAdapter since hdl-msh-01, and nothing calls
  // emitActuationResult() any more, so it could only ever read zero. The
  // stub's intended actions are logged, not counted; GET /lanes is where a
  // downstream actuator reads what it should do.

  const rotationFamily: MetricFamily = {
    name: "heimdall_rotation_events_total",
    help: "Total account rotation events by provider and kind (capped|rotated).",
    type: "counter",
    samples: store.getTelemetryEventCounts("rotation_event").map((row) => ({
      labels: { provider: row.labels.provider ?? "unknown", kind: row.labels.kind ?? "unknown" },
      value: row.count,
    })),
  };

  const substitutionFamily: MetricFamily = {
    name: "heimdall_model_substitutions_total",
    help: "Total times a declared model was substituted for a live, enabled alternative.",
    type: "counter",
    samples: store.getTelemetryEventCounts("model_substitution").map((row) => ({
      labels: { provider: row.labels.provider ?? "unknown" },
      value: row.count,
    })),
  };

  const routingFamily: MetricFamily = {
    name: "heimdall_routing_decisions_total",
    help: "Total scored-strategy routing decisions by result (lane|no_route).",
    type: "counter",
    samples: getRoutingDecisionCounts().map((row) => ({ labels: { result: row.result }, value: row.count })),
  };

  const catalogCountsByProviderEnabled = new Map<string, number>();
  for (const entry of store.getModelCatalog()) {
    const key = `${entry.provider}\u0000${entry.enabled}`;
    catalogCountsByProviderEnabled.set(key, (catalogCountsByProviderEnabled.get(key) ?? 0) + 1);
  }
  const catalogFamily: MetricFamily = {
    name: "heimdall_model_catalog_entries",
    help: "Model catalog entries by provider and enabled state.",
    type: "gauge",
    samples: [...catalogCountsByProviderEnabled.entries()].map(([key, value]) => {
      const [provider, enabled] = key.split("\u0000");
      return { labels: { provider, enabled }, value };
    }),
  };

  const probesFamily: MetricFamily = {
    name: "heimdall_probes_total",
    help: "Total lane sensing cycles (LanePipeline.refresh) by signal source and raw pre-corroboration result/error code; source=passive is a reported route outcome, result=error means the refresh threw.",
    type: "counter",
    samples: (sensing?.probeCounters() ?? []).map((row) => ({
      labels: { lane: row.lane, provider: row.provider, source: row.source, result: row.result, error_code: row.error_code },
      value: row.count,
    })),
  };

  const probeDurationFamily: MetricFamily = {
    name: "heimdall_probe_duration_seconds",
    help: "Wall-clock duration of one networked lane sensing cycle (source public_status or active_probe; passive and unconfigured cycles are not timed).",
    type: "histogram",
    samples: (sensing?.probeDurations() ?? []).flatMap((h) => {
      const labels = { lane: h.lane, provider: h.provider };
      return [
        ...h.buckets.map((b) => ({ suffix: "_bucket", labels: { ...labels, le: String(b.le) }, value: b.count })),
        { suffix: "_bucket", labels: { ...labels, le: "+Inf" }, value: h.count },
        { suffix: "_sum", labels, value: h.sum },
        { suffix: "_count", labels, value: h.count },
      ];
    }),
  };

  // Read from lane_status_history, not SensingMetrics, so it survives a
  // restart. A declared lane that has never been observed has no sample —
  // alert on that with absent(), or use GET /readyz.
  const nowMs = now().getTime();
  const lastProbeAgeFamily: MetricFamily = {
    name: "heimdall_lane_last_probe_age_seconds",
    help: "Seconds since this lane's most recent recorded status observation (any signal source). No sample = never observed.",
    type: "gauge",
    samples: registry
      .list()
      .filter((lane) => store.hasRecordedStatus(lane.lane_id))
      .map((lane) => {
        const lastUpdatedMs = Date.parse(store.getCurrentStatus(lane.lane_id)?.last_updated ?? "");
        return { labels: { lane: lane.lane_id }, value: Math.max(0, Math.round((nowMs - lastUpdatedMs) / 1000)) };
      })
      .filter((sample) => Number.isFinite(sample.value)),
  };

  // One sample per (lane, state), 1 for the lane's current state and 0 for
  // the others — the usual Prometheus enum-gauge shape, so
  // `heimdall_lane_signal_state{state="stale"} == 1` alerts per lane.
  const signalStateFamily: MetricFamily = {
    name: "heimdall_lane_signal_state",
    help: "Whether a lane's status rests on a recent observation: never_probed, fresh, or stale (last observation older than N x the lane's expected probe interval). 1 = current state.",
    type: "gauge",
    samples: registry.list().flatMap((lane) => {
      const { signal_state } = getLaneSignal(store, lane.lane_id, { now: new Date(nowMs), multiplier: signalStaleMultiplier });
      return SIGNAL_STATES.map((state) => ({
        labels: { lane: lane.lane_id, state },
        value: state === signal_state ? 1 : 0,
      }));
    }),
  };

  const transitionsFamily: MetricFamily = {
    name: "heimdall_lane_status_transitions_total",
    help: "Total recorded lane status changes; from=none is a lane's first-ever status.",
    type: "counter",
    samples: (sensing?.transitionCounters() ?? []).map((row) => ({
      labels: { lane: row.lane, from: row.from, to: row.to },
      value: row.count,
    })),
  };

  const schedulerFailuresFamily: MetricFamily = {
    name: "heimdall_scheduler_start_failures_total",
    help: "Total lane scheduler start failures by scheduler (in_process|multica_autopilot). Any non-zero value means a lane is not being sensed as configured.",
    type: "counter",
    samples: (sensing?.schedulerFailureCounters() ?? []).map((row) => ({
      labels: { lane: row.lane, scheduler: row.scheduler },
      value: row.count,
    })),
  };

  return [
    lanesFamily,
    probesFamily,
    probeDurationFamily,
    lastProbeAgeFamily,
    signalStateFamily,
    transitionsFamily,
    schedulerFailuresFamily,
    rotationFamily,
    substitutionFamily,
    routingFamily,
    catalogFamily,
  ]
    .map(renderFamily)
    .join("\n\n") + "\n";
}
