import { test } from "node:test";
import assert from "node:assert/strict";
import { ArgusClient, createArgusEmitter, NOOP_ARGUS_EMITTER } from "./argus-client.js";
import type { Tracer, Span } from "@opentelemetry/api";

function fakeTracer(onStartSpan: (name: string, options: unknown) => void): Tracer {
  return {
    startSpan: (name: string, options?: unknown) => {
      onStartSpan(name, options);
      return { end: () => {} } as Span;
    },
  } as unknown as Tracer;
}

test("emitMetric starts a generic Pantheon metric span with contract attributes", () => {
  let captured: { name: string; options: any } | null = null;
  const tracer = fakeTracer((name, options) => {
    captured = { name, options };
  });
  const client = new ArgusClient({ tracer, now: () => "2026-07-27T12:00:00.000Z" });

  client.emitMetric({
    metricId: "heimdall.lane.tick",
    source: "heimdall.scheduler",
    name: "lane.tick",
    value: 1,
    unit: "count",
    attributes: { "lane.id": "codex", enabled: true, ignored: null },
  });

  assert.equal(captured?.name, "pantheon.metric.emit");
  assert.deepEqual(captured?.options.attributes, {
    "metric.id": "heimdall.lane.tick",
    "metric.source": "heimdall.scheduler",
    "metric.name": "lane.tick",
    "metric.value": "1",
    "metric.unit": "count",
    "metric.ts": "2026-07-27T12:00:00.000Z",
    "lane.id": "codex",
    enabled: "true",
  });
});

test("emitDecisionRecord starts a generic Pantheon decision span with contract attributes", () => {
  let captured: { name: string; options: any } | null = null;
  const tracer = fakeTracer((name, options) => {
    captured = { name, options };
  });
  const client = new ArgusClient({ tracer, now: () => "2026-07-27T12:00:00.000Z" });

  client.emitDecisionRecord({
    decisionId: "heimdall.lane.status_flip:codex",
    source: "heimdall.lane.pipeline",
    classifier: "lane_status_flip",
    decision: "down->up",
    attributes: { "lane.provider": "codex" },
  });

  assert.equal(captured?.name, "pantheon.decision_record.emit");
  assert.deepEqual(captured?.options.attributes, {
    "decision.id": "heimdall.lane.status_flip:codex",
    "decision.source": "heimdall.lane.pipeline",
    "decision.classifier": "lane_status_flip",
    "decision.value": "down->up",
    "decision.ts": "2026-07-27T12:00:00.000Z",
    "lane.provider": "codex",
  });
});

test("emitTick starts a span with the right name and attributes", () => {
  let captured: { name: string; options: any } | null = null;
  const tracer = fakeTracer((name, options) => {
    captured = { name, options };
  });
  const client = new ArgusClient({ tracer });

  client.emitTick({ laneId: "claude@mathew.dostal", provider: "claude", source: "active_probe" });

  assert.equal(captured?.name, "heimdall.lane.tick");
  assert.deepEqual(captured?.options.attributes, {
    "lane.id": "claude@mathew.dostal",
    "lane.provider": "claude",
    "signal.source": "active_probe",
  });
});

test("emitStatusFlip starts a span with the right name and attributes", () => {
  let captured: { name: string; options: any } | null = null;
  const tracer = fakeTracer((name, options) => {
    captured = { name, options };
  });
  const client = new ArgusClient({ tracer });

  client.emitStatusFlip({ laneId: "codex", provider: "codex", from: "up", to: "degraded" });

  assert.equal(captured?.name, "heimdall.lane.status_flip");
  assert.deepEqual(captured?.options.attributes, {
    "lane.id": "codex",
    "lane.provider": "codex",
    "status.from": "up",
    "status.to": "degraded",
  });
});

test("a tracer that throws is caught and logged, never propagates", () => {
  const errors: unknown[] = [];
  const tracer = {
    startSpan: () => {
      throw new Error("OTLP exporter unreachable");
    },
  } as unknown as Tracer;
  const client = new ArgusClient({ tracer, onError: (err) => errors.push(err) });

  assert.doesNotThrow(() => {
    client.emitTick({ laneId: "claude@mathew.dostal", provider: "claude", source: "passive" });
  });
  assert.equal(errors.length, 2);
  assert.match((errors[0] as Error).message, /OTLP exporter unreachable/);
});

test("a span.end() that throws is also caught and logged, never propagates", () => {
  const errors: unknown[] = [];
  const tracer = {
    startSpan: () =>
      ({
        end: () => {
          throw new Error("export failed");
        },
      }) as unknown as Span,
  } as unknown as Tracer;
  const client = new ArgusClient({ tracer, onError: (err) => errors.push(err) });

  assert.doesNotThrow(() => {
    client.emitStatusFlip({ laneId: "codex", provider: "codex", from: "degraded", to: "up" });
  });
  assert.equal(errors.length, 2);
});

test("NOOP_ARGUS_EMITTER makes every contract call a safe no-op", () => {
  assert.doesNotThrow(() => {
    NOOP_ARGUS_EMITTER.emitMetric({ source: "heimdall", name: "x", value: 1 });
    NOOP_ARGUS_EMITTER.emitDecisionRecord({
      decisionId: "decision-1",
      source: "heimdall",
      classifier: "test",
      decision: "noop",
    });
    NOOP_ARGUS_EMITTER.emitTick({ laneId: "codex", provider: "codex", source: "test" });
    NOOP_ARGUS_EMITTER.emitStatusFlip({ laneId: "codex", provider: "codex", from: "down", to: "up" });
    NOOP_ARGUS_EMITTER.emitActuationResult({
      laneId: "codex",
      provider: "codex",
      agentId: "agent-a",
      action: "disable",
      success: true,
    });
  });
});

test("createArgusEmitter returns the no-op emitter when Argus is explicitly disabled", () => {
  assert.equal(createArgusEmitter({ ARGUS_OTLP_DISABLED: "true" }), NOOP_ARGUS_EMITTER);
});
