// Heimdall's own local telemetry record (hdl-ot-01) — same 3-method
// ArgusEmitter interface ArgusClient implements, but writes to StateStore
// instead of pushing OTEL spans. Argus stops being the only place these
// facts exist; this is the source of truth, Argus (or anything else OTEL-
// compatible) is a downstream consumer layered on top via
// CompositeTelemetryEmitter.
//
// emitTick is intentionally a no-op here — high-frequency, low-value as an
// individual row; lane_status_history already records every status
// *observation*, which is the meaningful local record for lane liveness.

import type { ArgusEmitter } from "./argus-client.js";
import type { StateStore } from "../state-store.js";

export class LocalTelemetryRecorder implements ArgusEmitter {
  constructor(private readonly store: StateStore) {}

  emitTick(_params: { laneId: string; provider: string; source: string }): void {
    // No-op by design — see file header.
  }

  emitStatusFlip(params: { laneId: string; provider: string; from: string; to: string }): void {
    this.store.recordTelemetryEvent("lane_status_flip", {
      laneId: params.laneId,
      provider: params.provider,
      from: params.from,
      to: params.to,
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
    this.store.recordTelemetryEvent("actuation_result", {
      laneId: params.laneId,
      provider: params.provider,
      agentId: params.agentId,
      action: params.action,
      success: String(params.success),
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      ...(params.overrideActive !== undefined ? { overrideActive: String(params.overrideActive) } : {}),
    });
  }
}
