// Fans a single ArgusEmitter call out to every emitter in the list
// (hdl-ot-01) — the one seam that lets Heimdall's own LocalTelemetryRecorder
// and an optional ArgusClient (or any future OTEL consumer implementing the
// same interface) receive identical calls, without any existing call site
// changing its ArgusEmitter-typed parameter. Fire-and-forget per emitter,
// matching ArgusClient's own precedent: one emitter throwing must never
// block the others or the caller.

import type { ArgusEmitter } from "./argus-client.js";

export class CompositeTelemetryEmitter implements ArgusEmitter {
  constructor(
    private readonly emitters: readonly ArgusEmitter[],
    private readonly onError: (err: unknown) => void = (err) =>
      console.error("[composite-telemetry-emitter] one emitter failed:", err),
  ) {}

  emitTick(params: { laneId: string; provider: string; source: string }): void {
    this.fanOut((emitter) => emitter.emitTick(params));
  }

  emitStatusFlip(params: { laneId: string; provider: string; from: string; to: string }): void {
    this.fanOut((emitter) => emitter.emitStatusFlip(params));
  }

  emitActuationResult(params: Parameters<ArgusEmitter["emitActuationResult"]>[0]): void {
    this.fanOut((emitter) => emitter.emitActuationResult(params));
  }

  private fanOut(call: (emitter: ArgusEmitter) => void): void {
    for (const emitter of this.emitters) {
      try {
        call(emitter);
      } catch (err) {
        this.onError(err);
      }
    }
  }
}
