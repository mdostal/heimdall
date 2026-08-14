// Shared routing-strategy contract (hdl-rs-02, widened in hdl-rr-02). Each
// strategy picks (or declines to pick) one lane from an already-filtered
// candidate list — candidacy filtering (credential resolved, override-aware
// sensed status; see route-selector.ts's getAvailableRoute) is a single
// shared concern upstream of every strategy, not duplicated inside each one.
//
// hdl-rr-02: widened from selectRoute(taskType, candidates): Lane | null to
// selectRoute(ctx): RouteSelectionResult so a scored strategy can access
// StateStore (to write a decision ledger) and return optional rationale/
// decision-id/experiment-arm/ranked-candidates detail — without forcing
// priority/round-robin/off to know that concept exists. `detail` is always
// absent for those three; only `scored` populates it. This is the one seam a
// future strategy needs, and the only one — no other context/result change
// should be required to add another strategy later.

import type { Lane } from "../lane-registry.js";
import type { TaskType } from "../route-selector.js";
import type { StateStore } from "../state-store.js";

export interface RouteSelectionContext {
  readonly taskType: TaskType;
  readonly candidates: readonly Lane[];
  readonly store: StateStore;
}

export interface RouteSelectionDetail {
  rationale?: string;
  decisionId?: string;
  experimentArm?: string;
  rankedCandidates?: ReadonlyArray<{ laneId: string; score: number }>;
  policyVersion?: string;
}

export interface RouteSelectionResult {
  readonly lane: Lane | null;
  readonly detail?: RouteSelectionDetail;
}

export interface RoutingStrategy {
  readonly name: string;
  selectRoute(ctx: RouteSelectionContext): RouteSelectionResult;
}
