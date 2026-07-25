// Passive observation — REQ-01 mechanism. Deliberately provider-agnostic: it
// knows nothing about Claude/Codex specifically. Provider-specific extraction
// (e.g. which header names to read) lives in each provider's adapters
// (public-status/*.ts, active-probe/*.ts), not here.
//
// This is a pure function over a normalized "last response" shape — callers
// are responsible for normalizing a raw provider response/error into
// ResponseLike before calling observePassiveSignal.

export interface ResponseLike {
  ok: boolean;
  statusCode?: number;
  /** Normalized error classification, e.g. "rate_limit_error" | "billing_error". */
  errorType?: string;
  /** An absolute ISO-8601 reset timestamp, if the response exposed one. */
  resetAt?: string | null;
  message?: string;
}

export type PassiveSignalValue = "up" | "degraded" | "down" | "out_of_credit";

export interface PassiveSignal {
  status: PassiveSignalValue;
  reset_at: string | null;
  reason: string | null;
}

/**
 * Returns null ("no signal") when there's nothing recent to observe — callers
 * (lhs-03d's escalation logic) decide what to do about that; this function
 * never fabricates a state out of absence.
 */
export function observePassiveSignal(response: ResponseLike | null): PassiveSignal | null {
  if (!response) return null;

  if (response.errorType === "billing_error") {
    return {
      status: "out_of_credit",
      reset_at: response.resetAt ?? null,
      reason: response.message ?? "billing error",
    };
  }

  if (response.errorType === "rate_limit_error") {
    return {
      status: "degraded",
      reset_at: response.resetAt ?? null,
      reason: response.message ?? "rate limited",
    };
  }

  if (response.statusCode !== undefined && response.statusCode >= 500) {
    return {
      status: "down",
      reset_at: null,
      reason: response.message ?? `server error ${response.statusCode}`,
    };
  }

  if (response.ok) {
    return { status: "up", reset_at: null, reason: null };
  }

  return {
    status: "degraded",
    reset_at: response.resetAt ?? null,
    reason: response.message ?? "unrecognized error",
  };
}
