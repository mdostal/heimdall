// ControlAdapter — the reconcile-every-tick interface both actuation
// backends implement (hda-02). Called every sense-loop tick for every lane,
// NOT gated by transition-detection alone — this is what lets
// MulticaControlAdapter (hda-03) retry a failed attempt "for free" on the
// next tick. StubControlAdapter here just wraps the existing hdl-04
// ActuationStub (transition-detection, loud logging) for any lane with no
// Multica agent mapping.

import type { Lane } from "../lane-registry.js";
import type { LaneStatusValue } from "../status-model.js";
import { ActuationStub, type StubbedAction } from "../scheduler/actuation-stub.js";

export interface ControlAdapter {
  reconcile(lane: Lane, status: LaneStatusValue): Promise<void>;
}

export class StubControlAdapter implements ControlAdapter {
  constructor(
    private readonly stub: ActuationStub = new ActuationStub(
      () => new Date().toISOString(),
      // Loud by design (console.warn, not console.log) — per operator
      // instruction: unmapped lanes must never silently no-op.
      (message) => console.warn(message),
    ),
  ) {}

  async reconcile(lane: Lane, status: LaneStatusValue): Promise<void> {
    this.stub.onStatusChange({ lane_id: lane.lane_id, provider: lane.provider }, status);
  }

  getRecordedActions(): readonly StubbedAction[] {
    return this.stub.getRecordedActions();
  }
}
