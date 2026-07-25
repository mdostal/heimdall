// Lane status shape — the LaneRouterContract response type.
// See .pHive/planning/architecture.md "API Contract (REQ-05) — LaneRouterContract"
// and .pHive/planning/prd.md REQ-04 for the 4-state model this type encodes.

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

// --- REQ-04: 4-state resolution -------------------------------------------
//
// A pure function, deliberately isolated from every signal-source adapter
// (lhs-03a/03b/03c/03d) — it validates an untrusted "raw signal" (as if
// received straight from a parsed network response, not a compile-time-safe
// object) into a strict LaneStatus fragment, never throwing on malformed
// input.

export interface RawSignal {
  status?: unknown;
  reset_at?: unknown;
  reason?: unknown;
}

export interface ResolvedStatus {
  status: LaneStatusValue;
  reset_at: string | null;
  reason: string | null;
}

function isLaneStatusValue(value: unknown): value is LaneStatusValue {
  return typeof value === "string" && (LANE_STATUS_VALUES as readonly string[]).includes(value);
}

export function resolveStatus(raw: RawSignal | null | undefined): ResolvedStatus {
  if (!raw || typeof raw !== "object") {
    return { status: "degraded", reset_at: null, reason: "malformed signal input" };
  }

  if (!isLaneStatusValue(raw.status)) {
    return {
      status: "degraded",
      reset_at: null,
      reason: `unrecognized status value: ${String(raw.status)}`,
    };
  }

  return {
    status: raw.status,
    reset_at: typeof raw.reset_at === "string" ? raw.reset_at : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
  };
}
