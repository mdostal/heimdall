// ControlAdapter — the reconcile-every-tick interface (hda-02). Called
// every sense-loop tick for every lane, not gated by transition-detection
// alone — a retry-for-free design also inherited by whatever registers as
// a lane's adapter. hdl-msh-01: StubControlAdapter is now the only
// implementation — Heimdall no longer actuates Multica directly (see
// docs/decisions/DEC-hdl-multica-disable-contract.md). It wraps the
// existing hdl-04 ActuationStub (transition-detection, loud logging) for
// every lane, not just unmapped ones.

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
