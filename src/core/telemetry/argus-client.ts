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
    /** Reason for THIS action's outcome (e.g. an API error code). */
    reason?: string;
    /** Why the LANE is in its current status (e.g. "billing error (402)") — hdl-rar-02, distinct from `reason` above. */
    laneReason?: string;
    /** When the lane is expected to recover, if known — hdl-rar-02. */
    laneResetAt?: string;
    /** True when this action's block/allow decision was driven by a manual override rather than the sensed status — hdl-lo-01. */
    overrideActive?: boolean;
  }): void;
}

export interface ArgusClientOptions {
  /** Injectable for testing — defaults to the globally registered tracer. */
  tracer?: Tracer;
  /** Fire-and-forget failure hook — defaults to logging to stderr. */
  onError?: (err: unknown) => void;
}

const DEFAULT_TRACER_NAME = "heimdall.scheduler";

export class ArgusClient implements ArgusEmitter {
  private readonly tracer: Tracer;
  private readonly onError: (err: unknown) => void;

  constructor(options: ArgusClientOptions = {}) {
    this.tracer = options.tracer ?? trace.getTracer(DEFAULT_TRACER_NAME);
    this.onError =
      options.onError ??
      ((err) => console.error("[argus-client] emission failed:", err));
  }

  emitTick(params: { laneId: string; provider: string; source: string }): void {
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
    laneReason?: string;
    laneResetAt?: string;
    overrideActive?: boolean;
  }): void {
    this.safeEmit("heimdall.actuation.result", {
      "lane.id": params.laneId,
      "lane.provider": params.provider,
      "agent.id": params.agentId,
      action: params.action,
      success: String(params.success),
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      ...(params.laneReason !== undefined ? { "lane.reason": params.laneReason } : {}),
      ...(params.laneResetAt !== undefined ? { "lane.reset_at": params.laneResetAt } : {}),
      ...(params.overrideActive !== undefined ? { "override.active": String(params.overrideActive) } : {}),
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

// Argus, like Multica, is normally co-located with Heimdall in a typical
// Pantheon installation — "localhost" is the only default that's safe for
// every operator's deployment. A remote/Tailscale Argus host is a
// per-operator override via ARGUS_OTLP_HOST, never a code-baked default
// (see multica-rest-client.ts for the same reasoning applied to Multica).
const DEFAULT_ARGUS_HOST = "localhost";
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
