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

/**
 * Why a lane is in its current status — threaded alongside the bare status
 * enum so the block/allow decision (unchanged by this) can still be logged
 * with context: out-of-credit-until-reset_at vs down-for-unknown-reason are
 * operationally different events even though both currently block the same
 * way. Optional and additive — every existing caller passing just
 * (lane, status) keeps compiling and behaving identically.
 */
export interface ReconcileContext {
  reason: string | null;
  reset_at: string | null;
  /**
   * hdl-lo-01: a top-level operator directive that wins outright over the
   * sensed status in the block/allow decision when set. null (the default)
   * means "automatic" — status alone decides, unchanged from pre-hdl-lo-01
   * behavior. Optional so every existing caller passing just
   * {reason, reset_at} keeps compiling and behaving identically.
   */
  manualOverride?: "enabled" | "disabled" | null;
}

export interface ControlAdapter {
  reconcile(lane: Lane, status: LaneStatusValue, context?: ReconcileContext): Promise<void>;
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

  async reconcile(lane: Lane, status: LaneStatusValue, context?: ReconcileContext): Promise<void> {
    this.stub.onStatusChange({ lane_id: lane.lane_id, provider: lane.provider }, status, context);
  }

  getRecordedActions(): readonly StubbedAction[] {
    return this.stub.getRecordedActions();
  }
}
