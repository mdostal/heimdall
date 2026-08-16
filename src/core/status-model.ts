// Lane status shape — the LaneRouterContract response type.
// See .pHive/planning/architecture.md "API Contract (REQ-05) — LaneRouterContract"
// and .pHive/planning/prd.md REQ-04 for the 4-state model this type encodes.

export type LaneStatusValue = "up" | "down" | "out_of_credit" | "degraded";

export type SignalSource = "passive" | "public_status" | "active_probe";

// hdl-error-taxonomy: a normalized, cross-provider error classification —
// deliberately separate from LaneStatusValue. LaneStatusValue stays the
// simple, actionable state routing/actuation logic reasons about ("OUR
// state could be one of the 3 [suspect states] ... but then with full
// details underneath" — operator, 2026-08-16). ErrorCode is that "full
// detail underneath": WHY a lane is in that state, normalized enough for
// internal logic to decide what to DO (which retry/timer strategy applies)
// without needing to parse every provider's own free-text vocabulary.
// `reason` stays the native, provider-specific human-readable detail —
// never discarded in favor of the normalized code, kept alongside it.
export type ErrorCode =
  | "rate_limit" // transient, short-window throttle (RPM/TPM-style) — expected to self-heal on its own timer
  | "quota_exceeded" // longer-window cap (daily/weekly/monthly) — won't self-heal until a known/estimated reset
  | "billing_error" // payment/credit issue (e.g. HTTP 402) — won't self-heal without operator action
  | "auth_failed" // invalid/expired/revoked credential — won't self-heal by retrying, needs operator action
  | "server_error" // provider-side failure (5xx) — transient, provider's problem not the credential's
  | "network_error" // Heimdall couldn't reach the provider at all (DNS/timeout/connection refused)
  | "unknown"; // a real error occurred but didn't match any of the above

export const ERROR_CODES: readonly ErrorCode[] = [
  "rate_limit",
  "quota_exceeded",
  "billing_error",
  "auth_failed",
  "server_error",
  "network_error",
  "unknown",
];

export interface LaneStatus {
  lane_id: string;
  provider: string;
  status: LaneStatusValue;
  reset_at: string | null;
  reason: string | null;
  error_code: ErrorCode | null;
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
  error_code?: unknown;
}

export interface ResolvedStatus {
  status: LaneStatusValue;
  reset_at: string | null;
  reason: string | null;
  error_code: ErrorCode | null;
}

function isLaneStatusValue(value: unknown): value is LaneStatusValue {
  return typeof value === "string" && (LANE_STATUS_VALUES as readonly string[]).includes(value);
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export function resolveStatus(raw: RawSignal | null | undefined): ResolvedStatus {
  if (!raw || typeof raw !== "object") {
    return { status: "degraded", reset_at: null, reason: "malformed signal input", error_code: null };
  }

  if (!isLaneStatusValue(raw.status)) {
    return {
      status: "degraded",
      reset_at: null,
      reason: `unrecognized status value: ${String(raw.status)}`,
      error_code: null,
    };
  }

  return {
    status: raw.status,
    reset_at: typeof raw.reset_at === "string" ? raw.reset_at : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
    error_code: isErrorCode(raw.error_code) ? raw.error_code : null,
  };
}
