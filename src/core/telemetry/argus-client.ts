// Argus OTEL telemetry client — the first Node/TypeScript OTLP emitter in
// Pantheon (confirmed via direct repo research: no prior client exists to
// reuse). Emits one span per tick and per status-flip to Argus (host OTLP
// 4327 gRPC / 4328 HTTP -> Langfuse traces/cost + SigNoz infra).
//
// Fire-and-forget by design: Argus being unreachable must never break
// Heimdall's core health-check function (same "never crash the whole
// service" philosophy as REQ-07's credential-loading precedent). Emission
// failures are caught and logged, never thrown.

import { trace, type Tracer } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter as OtlpGrpcExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as OtlpHttpExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export interface ArgusEmitter {
  emitMetric(params: MetricEmission): void;
  emitDecisionRecord(params: DecisionRecordEmission): void;
  emitTick(params: { laneId: string; provider: string; source: string }): void;
  emitStatusFlip(params: {
    laneId: string;
    provider: string;
    from: string;
    to: string;
  }): void;
  /** hda-03: one emission per actuation attempt (success or failure) — the
   * partial-failure visibility requirement from the design discussion. */
  emitActuationResult(params: {
    laneId: string;
    provider: string;
    agentId: string;
    action: string;
    success: boolean;
    reason?: string;
  }): void;
}

export interface MetricEmission {
  metricId?: string;
  source: string;
  name: string;
  value: number;
  unit?: string;
  ts?: string;
  attributes?: Record<string, string | number | boolean | null | undefined>;
}

export interface DecisionRecordEmission {
  decisionId: string;
  source: string;
  classifier: string;
  decision: string;
  ts?: string;
  attributes?: Record<string, string | number | boolean | null | undefined>;
}

export interface ArgusClientOptions {
  /** Injectable for testing — defaults to the globally registered tracer. */
  tracer?: Tracer;
  /** Fire-and-forget failure hook — defaults to logging to stderr. */
  onError?: (err: unknown) => void;
  /** Injectable clock for deterministic decision-record/metric timestamps. */
  now?: () => string;
}

const DEFAULT_TRACER_NAME = "heimdall.scheduler";
const ARGUS_DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export class ArgusClient implements ArgusEmitter {
  private readonly tracer: Tracer;
  private readonly onError: (err: unknown) => void;
  private readonly now: () => string;

  constructor(options: ArgusClientOptions = {}) {
    this.tracer = options.tracer ?? trace.getTracer(DEFAULT_TRACER_NAME);
    this.onError =
      options.onError ??
      ((err) => console.error("[argus-client] emission failed:", err));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  emitMetric(params: MetricEmission): void {
    this.safeEmit("pantheon.metric.emit", {
      ...(params.metricId !== undefined ? { "metric.id": params.metricId } : {}),
      "metric.source": params.source,
      "metric.name": params.name,
      "metric.value": String(params.value),
      ...(params.unit !== undefined ? { "metric.unit": params.unit } : {}),
      "metric.ts": params.ts ?? this.now(),
      ...stringifyAttributes(params.attributes),
    });
  }

  emitDecisionRecord(params: DecisionRecordEmission): void {
    this.safeEmit("pantheon.decision_record.emit", {
      "decision.id": params.decisionId,
      "decision.source": params.source,
      "decision.classifier": params.classifier,
      "decision.value": params.decision,
      "decision.ts": params.ts ?? this.now(),
      ...stringifyAttributes(params.attributes),
    });
  }

  emitTick(params: { laneId: string; provider: string; source: string }): void {
    this.emitMetric({
      metricId: "heimdall.lane.tick",
      source: "heimdall.scheduler",
      name: "lane.tick",
      value: 1,
      unit: "count",
      attributes: {
        "lane.id": params.laneId,
        "lane.provider": params.provider,
        "signal.source": params.source,
      },
    });
    this.safeEmit("heimdall.lane.tick", {
      "lane.id": params.laneId,
      "lane.provider": params.provider,
      "signal.source": params.source,
    });
  }

  emitStatusFlip(params: {
    laneId: string;
    provider: string;
    from: string;
    to: string;
  }): void {
    this.emitDecisionRecord({
      decisionId: `heimdall.lane.status_flip:${params.laneId}`,
      source: "heimdall.lane.pipeline",
      classifier: "lane_status_flip",
      decision: `${params.from}->${params.to}`,
      attributes: {
        "lane.id": params.laneId,
        "lane.provider": params.provider,
        "status.from": params.from,
        "status.to": params.to,
      },
    });
    this.safeEmit("heimdall.lane.status_flip", {
      "lane.id": params.laneId,
      "lane.provider": params.provider,
      "status.from": params.from,
      "status.to": params.to,
    });
  }

  emitActuationResult(params: {
    laneId: string;
    provider: string;
    agentId: string;
    action: string;
    success: boolean;
    reason?: string;
  }): void {
    this.emitDecisionRecord({
      decisionId: `heimdall.actuation.result:${params.laneId}:${params.agentId}`,
      source: "heimdall.actuation",
      classifier: "control_adapter_reconcile",
      decision: `${params.action}:${params.success ? "success" : "failure"}`,
      attributes: {
        "lane.id": params.laneId,
        "lane.provider": params.provider,
        "agent.id": params.agentId,
        action: params.action,
        success: params.success,
        reason: params.reason,
      },
    });
    this.safeEmit("heimdall.actuation.result", {
      "lane.id": params.laneId,
      "lane.provider": params.provider,
      "agent.id": params.agentId,
      action: params.action,
      success: String(params.success),
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
    });
  }

  private safeEmit(name: string, attributes: Record<string, string>): void {
    try {
      const span = this.tracer.startSpan(name, { attributes });
      span.end();
    } catch (err) {
      this.onError(err);
    }
  }
}

function stringifyAttributes(
  attrs: Record<string, string | number | boolean | null | undefined> | undefined,
): Record<string, string> {
  if (!attrs) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) {
      result[key] = String(value);
    }
  }
  return result;
}

export const NOOP_ARGUS_EMITTER: ArgusEmitter = {
  emitMetric: () => {},
  emitDecisionRecord: () => {},
  emitTick: () => {},
  emitStatusFlip: () => {},
  emitActuationResult: () => {},
};

export function isArgusDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ARGUS_DISABLED_VALUES.has((env.ARGUS_OTLP_DISABLED ?? "").trim().toLowerCase());
}

export function createArgusEmitter(env: NodeJS.ProcessEnv = process.env): ArgusEmitter {
  return isArgusDisabled(env) ? NOOP_ARGUS_EMITTER : new ArgusClient();
}

// --- Production SDK bootstrap (real OTLP export to Argus) ------------------
//
// This is intentionally separate from ArgusClient above: production code
// (src/main.ts, hdl-05) calls startArgusSdk() once at process startup;
// ArgusClient/its tests never touch this — they inject a mock Tracer instead.

export type ArgusProtocol = "grpc" | "http";

export interface ArgusSdkOptions {
  protocol?: ArgusProtocol;
  host?: string;
  grpcPort?: number;
  httpPort?: number;
}

/** Real Argus host confirmed via direct research (2026-07-25): Tailscale 100.75.161.82. */
const DEFAULT_ARGUS_HOST = "100.75.161.82";
const DEFAULT_ARGUS_GRPC_PORT = 4327;
const DEFAULT_ARGUS_HTTP_PORT = 4328;

export function startArgusSdk(options: ArgusSdkOptions = {}): NodeSDK {
  const protocol =
    options.protocol ?? (process.env.ARGUS_OTLP_PROTOCOL as ArgusProtocol | undefined) ?? "grpc";
  const host = options.host ?? process.env.ARGUS_OTLP_HOST ?? DEFAULT_ARGUS_HOST;
  const grpcPort = options.grpcPort ?? Number(process.env.ARGUS_OTLP_GRPC_PORT ?? DEFAULT_ARGUS_GRPC_PORT);
  const httpPort = options.httpPort ?? Number(process.env.ARGUS_OTLP_HTTP_PORT ?? DEFAULT_ARGUS_HTTP_PORT);

  const traceExporter =
    protocol === "http"
      ? new OtlpHttpExporter({ url: `http://${host}:${httpPort}/v1/traces` })
      : new OtlpGrpcExporter({ url: `${host}:${grpcPort}` });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "heimdall" }),
    traceExporter,
  });
  sdk.start();
  return sdk;
}
