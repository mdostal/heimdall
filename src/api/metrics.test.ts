import { test } from "node:test";
import assert from "node:assert/strict";
import { LaneRegistry } from "../core/lane-registry.js";
import { StateStore } from "../core/state-store.js";
import { EnvCredentialSource } from "../core/credential-source.js";
import { renderMetrics } from "./metrics.js";
import { SensingMetrics } from "../core/telemetry/sensing-metrics.js";
import { LanePipeline, type ProviderAdapters } from "../core/lane-pipeline.js";
import type { LaneStatusValue, ErrorCode } from "../core/status-model.js";
import { useRouteLedgerPath } from "../core/route-selector.js";

// heimdall#96: the route ledger defaults to the per-machine DB file; keep this
// file's routing decisions in memory instead.
useRouteLedgerPath(":memory:");

test("hdl-ot-03: renderMetrics output is well-formed Prometheus text exposition format", () => {
  const registry = new LaneRegistry(
    [{ lane_id: "claude@x", provider: "claude", credential_ref: "C" }],
    new EnvCredentialSource({ C: "secret" }),
  );
  const store = new StateStore(":memory:");
  store.recordTelemetryEvent("rotation_event", { provider: "claude", kind: "rotated" });
  const sensing = new SensingMetrics();
  sensing.recordProbe({ lane: "claude@x", provider: "claude", source: "active_probe", result: "up", errorCode: "none", durationSeconds: 0.0000001 });
  sensing.recordStatusTransition("claude@x", "none", "up");
  sensing.recordSchedulerStartFailure("claude@x", "multica_autopilot", new Error("bad cron"));
  store.recordStatus({ lane_id: "claude@x", status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: new Date().toISOString() });

  const body = renderMetrics(registry, store, sensing);
  const lines = body.trimEnd().split("\n").filter((line) => line.length > 0);

  let pendingHelp: string | null = null;
  let pendingType: string | null = null;
  for (const line of lines) {
    if (line.startsWith("# HELP ")) {
      pendingHelp = line.split(" ")[2];
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const parts = line.split(" ");
      pendingType = parts[2];
      assert.equal(parts[2], pendingHelp, "TYPE must immediately follow HELP for the same metric family");
      assert.ok(["counter", "gauge", "histogram"].includes(parts[3]), `unexpected metric type: ${parts[3]}`);
      continue;
    }
    // A metric sample line — must start with the most recently declared family name.
    assert.ok(pendingType && line.startsWith(pendingType), `sample line "${line}" is not preceded by a matching HELP/TYPE pair`);
    assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.]+$/, `sample line "${line}" is not valid Prometheus exposition format`);
  }

  store.close();
});

test("hdl-ot-03: renderMetrics never crashes on a completely empty store", () => {
  const registry = new LaneRegistry([], new EnvCredentialSource({}));
  const store = new StateStore(":memory:");
  assert.doesNotThrow(() => renderMetrics(registry, store));
  store.close();
});

function sampleValue(body: string, series: string): number | undefined {
  const line = body.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

test("PANT-824: a fake probe driven up -> down -> up shows up in probes, transitions and last-probe-age", async () => {
  const lane = { lane_id: "claude@x", provider: "claude", credential_ref: "C", credential: "secret" };
  const registry = new LaneRegistry([{ lane_id: lane.lane_id, provider: lane.provider, credential_ref: "C" }], new EnvCredentialSource({ C: "secret" }));
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: lane.lane_id, provider: lane.provider, credential_ref: "C" });
  const sensing = new SensingMetrics();

  // down needs two consecutive reads to be corroborated (first one reads as degraded).
  const script: Array<{ status: LaneStatusValue; error_code: ErrorCode | null }> = [
    { status: "up", error_code: null },
    { status: "down", error_code: "server_error" },
    { status: "down", error_code: "server_error" },
    { status: "up", error_code: null },
  ];
  let call = 0;
  const adapters: ProviderAdapters = {
    checkPublicStatus: async () => ({ status: "up", reason: null }),
    probe: async () => ({ ...script[call++], reset_at: null, reason: "fake" }),
  };
  // Each refresh is 2 minutes apart — past the 60s public-status staleness,
  // so every refresh goes to the (fake) active probe. Each probe "takes" 0.3s.
  let clockMs = Date.parse("2026-09-27T12:00:00.000Z");
  let mono = 0;
  const pipeline = new LanePipeline(
    store,
    {
      now: () => new Date(clockMs).toISOString(),
      lastPassiveResponse: () => null,
      monotonicNowMs: () => (mono += 150),
    },
    adapters,
    sensing,
  );
  for (let i = 0; i < script.length; i++) {
    await pipeline.refresh(lane);
    clockMs += 120_000;
  }
  assert.equal(store.getCurrentStatus(lane.lane_id)?.status, "up");

  // "now" = 90s after the last probe (which was recorded at clockMs - 120s).
  const body = renderMetrics(registry, store, sensing, () => new Date(clockMs - 120_000 + 90_000));

  assert.equal(sampleValue(body, 'heimdall_probes_total{lane="claude@x",provider="claude",source="active_probe",result="up",error_code="none"}'), 2);
  assert.equal(sampleValue(body, 'heimdall_probes_total{lane="claude@x",provider="claude",source="active_probe",result="down",error_code="server_error"}'), 2);

  assert.equal(sampleValue(body, 'heimdall_lane_status_transitions_total{lane="claude@x",from="none",to="up"}'), 1);
  assert.equal(sampleValue(body, 'heimdall_lane_status_transitions_total{lane="claude@x",from="up",to="degraded"}'), 1);
  assert.equal(sampleValue(body, 'heimdall_lane_status_transitions_total{lane="claude@x",from="degraded",to="down"}'), 1);
  assert.equal(sampleValue(body, 'heimdall_lane_status_transitions_total{lane="claude@x",from="down",to="up"}'), 1);

  assert.equal(sampleValue(body, 'heimdall_lane_last_probe_age_seconds{lane="claude@x"}'), 90);

  assert.equal(sampleValue(body, 'heimdall_probe_duration_seconds_count{lane="claude@x",provider="claude"}'), 4);
  assert.equal(sampleValue(body, 'heimdall_probe_duration_seconds_bucket{lane="claude@x",provider="claude",le="0.1"}'), 0);
  assert.equal(sampleValue(body, 'heimdall_probe_duration_seconds_bucket{lane="claude@x",provider="claude",le="0.25"}'), 4);
  assert.equal(sampleValue(body, 'heimdall_probe_duration_seconds_bucket{lane="claude@x",provider="claude",le="+Inf"}'), 4);
  assert.ok(Math.abs((sampleValue(body, 'heimdall_probe_duration_seconds_sum{lane="claude@x",provider="claude"}') ?? 0) - 0.6) < 1e-9);

  store.close();
});

test("PANT-824: a probe adapter that throws is still counted, as result=error", async () => {
  const lane = { lane_id: "codex", provider: "codex", credential_ref: "C", credential: "secret" };
  const registry = new LaneRegistry([{ lane_id: "codex", provider: "codex", credential_ref: "C" }], new EnvCredentialSource({ C: "secret" }));
  const store = new StateStore(":memory:");
  const sensing = new SensingMetrics();
  const pipeline = new LanePipeline(
    store,
    { now: () => "2026-09-27T12:00:00.000Z", lastPassiveResponse: () => null },
    { checkPublicStatus: async () => ({ status: "up", reason: null }), probe: async () => { throw new Error("boom"); } },
    sensing,
  );
  await assert.rejects(pipeline.refresh(lane), /boom/);

  const body = renderMetrics(registry, store, sensing);
  assert.equal(sampleValue(body, 'heimdall_probes_total{lane="codex",provider="codex",source="active_probe",result="error",error_code="exception"}'), 1);
  // Never observed -> no last-probe-age sample (alert with absent(), or use GET /readyz).
  assert.equal(sampleValue(body, 'heimdall_lane_last_probe_age_seconds{lane="codex"}'), undefined);
  store.close();
});

test("PANT-824: heimdall_actuation_results_total is no longer exported (stub adapters can never produce it)", () => {
  const registry = new LaneRegistry([], new EnvCredentialSource({}));
  const store = new StateStore(":memory:");
  store.recordTelemetryEvent("actuation_result", { provider: "claude", action: "disable", success: "true" });
  assert.ok(!renderMetrics(registry, store).includes("heimdall_actuation_results_total"));
  store.close();
});

test("PANT-824 x heimdall#96: a passive route-outcome refresh is counted as source=passive but not timed", async () => {
  const lane = { lane_id: "claude@x", provider: "claude", credential_ref: "C", credential: "secret" };
  const registry = new LaneRegistry([{ lane_id: lane.lane_id, provider: lane.provider, credential_ref: "C" }], new EnvCredentialSource({ C: "secret" }));
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: lane.lane_id, provider: lane.provider, credential_ref: "C" });
  const sensing = new SensingMetrics();

  // One pending route outcome (success -> passive "up"), consumed once, like RouteOutcomeTracker.take().
  let pending: { ok: true; classifiedStatus: "up" } | null = { ok: true, classifiedStatus: "up" };
  let probeCalls = 0;
  let mono = 0;
  const pipeline = new LanePipeline(
    store,
    {
      now: () => "2026-09-27T12:00:00.000Z",
      lastPassiveResponse: () => {
        const taken = pending;
        pending = null;
        return taken;
      },
      monotonicNowMs: () => (mono += 500),
    },
    {
      checkPublicStatus: async () => ({ status: "up", reason: null }),
      probe: async () => {
        probeCalls++;
        return { status: "up", reset_at: null, reason: null, error_code: null };
      },
    },
    sensing,
  );

  await pipeline.refresh(lane);
  assert.equal(probeCalls, 0, "the pending route outcome decides the status without an active probe");
  assert.equal(store.getCurrentStatus(lane.lane_id)?.signal_source, "passive");

  const body = renderMetrics(registry, store, sensing);
  assert.equal(sampleValue(body, 'heimdall_probes_total{lane="claude@x",provider="claude",source="passive",result="up",error_code="none"}'), 1);
  assert.equal(sampleValue(body, 'heimdall_lane_status_transitions_total{lane="claude@x",from="none",to="up"}'), 1);
  // Passive reads do no network I/O, so they stay out of the latency histogram.
  assert.equal(sampleValue(body, 'heimdall_probe_duration_seconds_count{lane="claude@x",provider="claude"}'), undefined);
  store.close();
});

test("PANT-823: a never-probed lane is counted under status=\"unknown\", never \"down\", and heimdall_lane_signal_state reports it", () => {
  const registry = new LaneRegistry(
    [
      { lane_id: "claude@never", provider: "claude", credential_ref: "C" },
      { lane_id: "claude@fresh", provider: "claude", credential_ref: "C" },
      { lane_id: "claude@stale", provider: "claude", credential_ref: "C" },
    ],
    new EnvCredentialSource({ C: "secret" }),
  );
  const store = new StateStore(":memory:");
  for (const lane of registry.list()) {
    store.upsertLane({ lane_id: lane.lane_id, provider: lane.provider, credential_ref: lane.credential_ref });
  }
  const now = new Date("2026-09-28T12:00:00.000Z");
  store.recordStatus({ lane_id: "claude@fresh", status: "down", reset_at: null, reason: "probe failed", signal_source: "active_probe", observed_at: now.toISOString() });
  store.recordStatus({ lane_id: "claude@stale", status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: "2026-09-28T09:00:00.000Z" });

  const body = renderMetrics(registry, store, undefined, () => now, 3);

  // Only the lane that was actually observed down counts as down.
  assert.equal(sampleValue(body, 'heimdall_lanes{provider="claude",status="down"}'), 1);
  assert.equal(sampleValue(body, 'heimdall_lanes{provider="claude",status="unknown"}'), 1);
  assert.equal(sampleValue(body, 'heimdall_lanes{provider="claude",status="up"}'), 1);

  assert.match(body, /^# TYPE heimdall_lane_signal_state gauge$/m);
  assert.equal(sampleValue(body, 'heimdall_lane_signal_state{lane="claude@never",state="never_probed"}'), 1);
  assert.equal(sampleValue(body, 'heimdall_lane_signal_state{lane="claude@never",state="fresh"}'), 0);
  assert.equal(sampleValue(body, 'heimdall_lane_signal_state{lane="claude@fresh",state="fresh"}'), 1);
  assert.equal(sampleValue(body, 'heimdall_lane_signal_state{lane="claude@stale",state="stale"}'), 1);
  assert.equal(sampleValue(body, 'heimdall_lane_signal_state{lane="claude@stale",state="fresh"}'), 0);
  store.close();
});
