import { test } from "node:test";
import assert from "node:assert/strict";
import { ArgusClient } from "./argus-client.js";
import type { Tracer, Span } from "@opentelemetry/api";

function fakeTracer(onStartSpan: (name: string, options: unknown) => void): Tracer {
  return {
    startSpan: (name: string, options?: unknown) => {
      onStartSpan(name, options);
      return { end: () => {} } as Span;
    },
  } as unknown as Tracer;
}

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
  assert.equal(errors.length, 1);
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
  assert.equal(errors.length, 1);
});
