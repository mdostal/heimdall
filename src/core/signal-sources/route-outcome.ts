// heimdall#96: turns a reported route outcome (POST /route/:decisionId/outcome)
// into a passive observation of the lane that served it, closing the routing
// loop VISION ③ describes. Two pieces:
//
// - routeOutcomeToPassiveResponse(): pure classification. A success outcome
//   is passive evidence of `up`. A failure outcome only counts when its error
//   is classifiable by error-parser; an unclassifiable failure (a bad prompt,
//   a caller-side bug) says nothing about the lane, so it yields no signal.
// - RouteOutcomeTracker: the most recent unconsumed outcome per lane, read by
//   LanePipeline through RefreshDeps.lastPassiveResponse.

import { parseClaudeCapSignal, type ClaudeCapKind } from "../error-parser.js";
import type { ErrorCode } from "../status-model.js";
import type { PassiveSignalValue, ResponseLike } from "./passive.js";

const SUCCESS_OUTCOMES = new Set(["success", "succeeded", "ok", "completed"]);
const FAILURE_OUTCOMES = new Set(["failure", "failed", "error"]);

// A cap error on real routed traffic means the lane just failed actual work,
// so a plain rate limit resolves to `down` (until its reset_at), not the
// `degraded` a lone probe 429 gets. The corroboration policy still applies:
// one outcome only ever shows `degraded`.
const CAP_KIND_TO_STATUS: Record<ClaudeCapKind, { status: PassiveSignalValue; errorCode: ErrorCode }> = {
  rate_limit: { status: "down", errorCode: "rate_limit" },
  session_limit: { status: "out_of_credit", errorCode: "quota_exceeded" },
  weekly_limit: { status: "out_of_credit", errorCode: "quota_exceeded" },
  oauth_expired: { status: "down", errorCode: "auth_failed" },
};

export interface RouteOutcomeReport {
  outcome: string | null;
  /** The reported metadata; a failure's error object lives under `error`. */
  metadata: Record<string, unknown> | null;
}

export function routeOutcomeToPassiveResponse(report: RouteOutcomeReport, now: Date): ResponseLike | null {
  const outcome = report.outcome?.trim().toLowerCase() ?? "";
  if (SUCCESS_OUTCOMES.has(outcome)) {
    return { ok: true, classifiedStatus: "up" };
  }
  if (!FAILURE_OUTCOMES.has(outcome)) return null;

  const cap = parseClaudeCapSignal(report.metadata?.error, now);
  if (!cap) return null;

  const { status, errorCode } = CAP_KIND_TO_STATUS[cap.kind];
  return {
    ok: false,
    classifiedStatus: status,
    errorCode,
    resetAt: cap.reset_at,
    message: `route outcome: ${cap.reason}`,
  };
}

/**
 * Consume-once on purpose: LanePipeline's corroboration compares each
 * verdict with the previous one, so handing the same outcome to two
 * refreshes would let one bad outcome corroborate itself and flip the lane.
 */
export class RouteOutcomeTracker {
  private readonly pendingByLane = new Map<string, ResponseLike>();

  record(laneId: string, response: ResponseLike): void {
    this.pendingByLane.set(laneId, response);
  }

  take(laneId: string): ResponseLike | null {
    const pending = this.pendingByLane.get(laneId) ?? null;
    this.pendingByLane.delete(laneId);
    return pending;
  }
}
