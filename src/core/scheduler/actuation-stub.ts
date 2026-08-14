// Actuation stub — Heimdall's third interaction mode (hdl-04), alongside the
// already-built agent-call (MCP) and API-call (HTTP/CLI) surfaces.
//
// STUB ONLY, by explicit operator instruction: records the intended action
// ("would disable/re-enable this lane's Multica runtime") on a genuine
// status transition, without calling any real Multica runtime-toggle API —
// that API/contract doesn't exist yet and is future scope, not this epic.

export interface StubbedAction {
  laneId: string;
  provider: string;
  from: string;
  to: string;
  intendedAction: string;
  recordedAt: string;
  /** Why the lane is now in `to` — threaded through from the status signal, not derived here. */
  reason: string | null;
  reset_at: string | null;
  /** hdl-lo-01: the manual override in effect when this transition was recorded, if any. */
  manualOverride: "enabled" | "disabled" | null;
}

const SUSPECT_STATUSES = new Set(["down", "degraded", "out_of_credit"]);

function describeIntendedAction(from: string, to: string): string {
  const fromSuspect = SUSPECT_STATUSES.has(from);
  const toSuspect = SUSPECT_STATUSES.has(to);
  if (toSuspect && !fromSuspect) {
    return `would disable Multica runtime for this lane (${from} -> ${to})`;
  }
  if (!toSuspect && fromSuspect) {
    return `would re-enable Multica runtime for this lane (${from} -> ${to})`;
  }
  return `status changed ${from} -> ${to} (no runtime action stubbed for this transition)`;
}

export class ActuationStub {
  private readonly lastKnownStatus = new Map<string, string>();
  private readonly recorded: StubbedAction[] = [];

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly log: (message: string) => void = console.log,
  ) {}

  /**
   * Call whenever a lane's current status is observed. Fires (records +
   * logs) exactly once per genuine transition — the first observation of a
   * lane establishes its baseline and does NOT fire (nothing to compare
   * against yet), and repeated identical statuses never fire again.
   */
  onStatusChange(
    lane: { lane_id: string; provider: string },
    newStatus: string,
    context?: {
      reason: string | null;
      reset_at: string | null;
      manualOverride?: "enabled" | "disabled" | null;
    },
  ): void {
    const previous = this.lastKnownStatus.get(lane.lane_id);
    this.lastKnownStatus.set(lane.lane_id, newStatus);

    if (previous === undefined || previous === newStatus) return;

    const action: StubbedAction = {
      laneId: lane.lane_id,
      provider: lane.provider,
      from: previous,
      to: newStatus,
      intendedAction: describeIntendedAction(previous, newStatus),
      recordedAt: this.now(),
      reason: context?.reason ?? null,
      reset_at: context?.reset_at ?? null,
      manualOverride: context?.manualOverride ?? null,
    };
    this.recorded.push(action);
    const overrideSuffix = action.manualOverride ? ` [manual override: ${action.manualOverride}]` : "";
    const reasonSuffix = action.reason ? ` (${action.reason}${action.reset_at ? `, reset_at=${action.reset_at}` : ""})` : "";
    this.log(`[actuation-stub] lane=${action.laneId}: ${action.intendedAction}${reasonSuffix}${overrideSuffix}`);
  }

  getRecordedActions(): readonly StubbedAction[] {
    return this.recorded;
  }
}
