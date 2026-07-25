// Lane status shape — the LaneRouterContract response type.
// See .pHive/planning/architecture.md "API Contract (REQ-05) — LaneRouterContract"
// and .pHive/planning/prd.md REQ-04 for the 4-state model this type encodes.
//
// Resolution logic (turning a raw signal into one of these 4 states) is
// implemented in a later story (lhs-03e) — this file is intentionally
// type-only for now (lhs-01 scope).

export type LaneStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export type SignalSource = "passive" | "public_status" | "active_probe";

export interface LaneStatus {
  lane_id: string;
  provider: string;
  status: LaneStatusValue;
  reset_at: string | null;
  reason: string | null;
  last_updated: string;
  signal_source: SignalSource;
}

export const LANE_STATUS_VALUES: readonly LaneStatusValue[] = [
  "up",
  "down",
  "out_of_credit",
  "degraded",
];

export const SIGNAL_SOURCES: readonly SignalSource[] = [
  "passive",
  "public_status",
  "active_probe",
];
